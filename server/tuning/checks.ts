import type {
  BenchDevice,
  Check,
  CheckFamily,
  CpuInfo,
  DiskSpeed,
  Estimate,
  GpuSample,
  MemInfo,
} from "@llama-webui/shared";
import type { ModelInfo } from "../models/gguf";
import { fmtBytes, GiB } from "./memory";
import type { SysReadings } from "./sysinfo";

export type { Check };

export interface CheckContext {
  readings: SysReadings;
  gpus: GpuSample[];
  /** Bus ids of the cards llama-server will run on. */
  retainedBusIds: string[];
  devices: BenchDevice[];
  cpu: CpuInfo;
  model: ModelInfo | null;
  estimate: Estimate | null;
  mem: MemInfo | null;
  /** Dernière mesure de lecture séquentielle du disque du modèle. */
  diskSpeed: DiskSpeed | null;
  now: number;
}

/** En dessous, un modèle qui déborde la RAM est limité par le disque. */
const DISK_OK_BPS = 2 * GiB;

const NA = "non applicable (carte ignorée)";
const OLD_BUILD_MS = 60 * 86400_000;
const NETWORK_FS = /^(nfs|nfs4|cifs|smb3?|fuse|sshfs|9p|afs|ceph|glusterfs)/;

const pcieLabel = (gen: number | null | undefined, width: number | null | undefined) =>
  `x${width ?? "?"} Gen${gen ?? "?"}`;

export function runChecks(ctx: CheckContext): Check[] {
  const { readings: r, estimate } = ctx;
  const out: Check[] = [];
  const push = (c: Check) => out.push(c);
  const retained = (bus: string) => ctx.retainedBusIds.includes(bus);
  const overflow = (estimate?.ok ?? false) && (estimate?.params.ngl !== "all" || !!estimate?.params.ncmoe);
  const nvidia = ctx.gpus.filter((g) => g.vendor === "nvidia");
  const amd = ctx.gpus.filter((g) => g.vendor === "amd");

  const pcie = (family: CheckFamily, g: GpuSample) => {
    const id = `${family}.pcie.${g.busId}`;
    const label = `Lien PCIe ${g.name}`;
    const impact = "chargement et offload CPU↔GPU plus lents";
    if (g.pcieGenMax == null || g.pcieWidthMax == null)
      return push({ id, family, label, state: "unknown", detail: "lien PCIe inconnu", impact });
    // Idle links train down (ASPM): only a link seen under load says anything (null until then, see withObservedLinks).
    if (g.pcieGen == null || g.pcieWidth == null)
      return push({
        id,
        family,
        label,
        state: "unknown",
        detail: "mesuré sous charge : lancer le serveur d'abord",
        impact,
      });
    const below =
      (g.pcieGen as number) < (g.pcieGenMax as number) || (g.pcieWidth as number) < (g.pcieWidthMax as number);
    push({
      id,
      family,
      label,
      state: below ? "warn" : "ok",
      detail: `${pcieLabel(g.pcieGen, g.pcieWidth)} (max ${pcieLabel(g.pcieGenMax, g.pcieWidthMax)})${below ? " : vérifier le slot, le riser ou le BIOS" : ""}`,
      persistence: below ? "permanent" : undefined,
      impact,
    });
  };

  if (nvidia.length > 0) {
    for (const g of nvidia) {
      const bus = g.busId;
      const on = retained(bus);
      // nvidia-smi's own index need not match ours (sorted by bus id): the UUID names the card unambiguously.
      const smiId = g.key.startsWith("nvidia:") ? g.key.slice("nvidia:".length) : bus;
      // persistence
      {
        const id = `nvidia.persistence.${bus}`;
        const label = `Persistance ${g.name}`;
        const impact = "premier chargement et réveil de la carte plus lents";
        if (!on) push({ id, family: "nvidia", label, state: "na", detail: NA, impact });
        else if (g.persistence == null)
          push({ id, family: "nvidia", label, state: "unknown", detail: "NVML ne le dit pas", impact });
        else if (g.persistence) push({ id, family: "nvidia", label, state: "ok", detail: "activée", impact });
        else
          push({
            id,
            family: "nvidia",
            label,
            state: "warn",
            detail: "désactivée",
            command: `sudo nvidia-smi -i ${smiId} -pm 1`,
            persistence: "session",
            impact,
          });
      }
      // power limit
      {
        const id = `nvidia.powerlimit.${bus}`;
        const label = `Limite de puissance ${g.name}`;
        const impact = "fréquences bridées sous charge";
        if (!on) push({ id, family: "nvidia", label, state: "na", detail: NA, impact });
        else if (g.powerLimitW == null || g.powerDefaultLimitW == null)
          push({ id, family: "nvidia", label, state: "unknown", detail: "limite inconnue", impact });
        else if (g.powerLimitW < g.powerDefaultLimitW - 1)
          push({
            id,
            family: "nvidia",
            label,
            state: "warn",
            detail: `${Math.round(g.powerLimitW)} W, défaut ${Math.round(g.powerDefaultLimitW)} W`,
            command: `sudo nvidia-smi -i ${smiId} -pl ${Math.round(g.powerDefaultLimitW)}`,
            persistence: "session",
            impact,
          });
        else
          push({ id, family: "nvidia", label, state: "ok", detail: `${Math.round(g.powerLimitW)} W (défaut)`, impact });
      }
      pcie("nvidia", g);
      // resizable BAR
      {
        const id = `nvidia.rebar.${bus}`;
        const label = `Resizable BAR ${g.name}`;
        const impact = "transferts hôte→VRAM par fenêtre de 256 MiB";
        const bar = r.bar1Bytes[bus];
        if (bar === undefined || g.vramTotalBytes <= 0)
          push({ id, family: "nvidia", label, state: "unknown", detail: "taille du BAR1 inconnue", impact });
        else if (bar < g.vramTotalBytes)
          push({
            id,
            family: "nvidia",
            label,
            state: "warn",
            detail: `BAR1 ${fmtBytes(bar)} < VRAM ${fmtBytes(g.vramTotalBytes)} : activer Resizable BAR / Above 4G dans le BIOS`,
            persistence: "permanent",
            impact,
          });
        else push({ id, family: "nvidia", label, state: "ok", detail: `BAR1 ${fmtBytes(bar)}`, impact });
      }
    }
    {
      const id = "nvidia.driver";
      const label = "Pilote NVIDIA";
      const impact = "le backend CUDA du build refuse de démarrer";
      const cuda =
        r.cudaDriver == null
          ? ""
          : `, CUDA ${Math.floor(r.cudaDriver / 1000)}.${Math.floor((r.cudaDriver % 1000) / 10)}`;
      if (r.cudaDriverError)
        push({
          id,
          family: "nvidia",
          label,
          state: "warn",
          detail: `trop ancien pour le CUDA du build (pilote ${r.driver ?? "?"}${cuda}) : mettre à jour le pilote`,
          persistence: "permanent",
          impact,
        });
      else if (r.driver === null)
        push({ id, family: "nvidia", label, state: "unknown", detail: "version inconnue", impact });
      else push({ id, family: "nvidia", label, state: "ok", detail: `pilote ${r.driver}${cuda}`, impact });
    }
    {
      const id = "nvidia.uvm";
      const label = "Module nvidia_uvm";
      const impact = "CUDA ne s'initialise pas";
      if (r.modules.length === 0)
        push({ id, family: "nvidia", label, state: "unknown", detail: "/proc/modules illisible", impact });
      else if (r.modules.includes("nvidia_uvm"))
        push({ id, family: "nvidia", label, state: "ok", detail: "chargé", impact });
      else
        push({
          id,
          family: "nvidia",
          label,
          state: "warn",
          detail: "absent",
          command: "sudo modprobe nvidia_uvm",
          persistence: "session",
          impact,
        });
    }
  }

  if (amd.length > 0) {
    const anyRetained = amd.some((g) => retained(g.busId));
    for (const g of amd) {
      const id = `amd.dpm.${g.busId}`;
      const label = `Niveau DPM ${g.name}`;
      const impact = "fréquences qui hésitent sous charge";
      const dpm = r.amdDpm[g.busId];
      if (!retained(g.busId)) push({ id, family: "amd", label, state: "na", detail: NA, impact });
      else if (!dpm)
        push({
          id,
          family: "amd",
          label,
          state: "unknown",
          detail: "power_dpm_force_performance_level illisible",
          impact,
        });
      else if (dpm.level === "auto")
        push({
          id,
          family: "amd",
          label,
          state: "warn",
          detail: "auto",
          command: `echo high | sudo tee ${dpm.path}`,
          persistence: "session",
          impact,
        });
      else push({ id, family: "amd", label, state: "ok", detail: dpm.level, impact });
      pcie("amd", g);
    }
    {
      const id = "amd.hip";
      const label = "Backend ROCm/HIP";
      const impact = "la carte AMD tourne en Vulkan, plus lent";
      if (!anyRetained) push({ id, family: "amd", label, state: "na", detail: NA, impact });
      else if (r.backendLibs.length === 0)
        push({ id, family: "amd", label, state: "unknown", detail: "bibliothèques du build introuvables", impact });
      else if (r.backendLibs.some((l) => l.startsWith("libggml-hip")))
        push({ id, family: "amd", label, state: "ok", detail: "présent", impact });
      else
        push({
          id,
          family: "amd",
          label,
          state: "warn",
          detail: "absent : reconstruire llama.cpp avec -DGGML_HIP=ON, sinon Vulkan",
          persistence: "permanent",
          impact,
        });
    }
    {
      const id = "amd.rocm-gfx";
      const label = "Carte reconnue par ROCm";
      const impact = "HIP refuse la carte sans HSA_OVERRIDE_GFX_VERSION";
      if (!anyRetained) push({ id, family: "amd", label, state: "na", detail: NA, impact });
      else
        push({
          id,
          family: "amd",
          label,
          state: "unknown",
          detail:
            "rocminfo non consulté : si HIP refuse la carte, ajouter HSA_OVERRIDE_GFX_VERSION=… dans env du profil",
          impact,
        });
    }
  }

  // CPU / mémoire
  {
    const id = "cpu.governor";
    const label = "Gouverneur CPU";
    const impact = "prompt processing et offload CPU plus lents";
    const bad = r.governors.filter((g) => g !== "performance");
    if (r.governors.length === 0)
      push({ id, family: "cpu", label, state: "unknown", detail: "cpufreq illisible", impact });
    else if (bad.length === 0) push({ id, family: "cpu", label, state: "ok", detail: "performance", impact });
    else
      push({
        id,
        family: "cpu",
        label,
        state: "warn",
        detail: bad[0]!,
        command: "echo performance | sudo tee /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor",
        persistence: "session",
        impact,
      });
  }
  {
    const id = "cpu.thp";
    const label = "Transparent hugepages";
    const impact = "accès aux poids en RAM plus lents";
    if (r.thp === null) push({ id, family: "cpu", label, state: "unknown", detail: "illisible", impact });
    else if (r.thp === "never")
      push({
        id,
        family: "cpu",
        label,
        state: "warn",
        detail: "never ; permanent : transparent_hugepage=madvise sur la cmdline du noyau",
        command: "echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled",
        persistence: "session",
        impact,
      });
    else push({ id, family: "cpu", label, state: "ok", detail: r.thp, impact });
  }
  {
    const id = "cpu.memlock";
    const label = "Limite memlock";
    const impact = "--mlock échoue, les poids peuvent être évincés";
    const wantsMlock = estimate?.serverArgs.includes("--mlock") ?? false;
    const need = ctx.model?.fileBytes ?? 0;
    if (!wantsMlock) push({ id, family: "cpu", label, state: "ok", detail: "--mlock non recommandé ici", impact });
    else if (r.memlockLimitBytes === null)
      push({ id, family: "cpu", label, state: "unknown", detail: "illisible", impact });
    else if (r.memlockLimitBytes < need)
      push({
        id,
        family: "cpu",
        label,
        state: "warn",
        detail: `${fmtBytes(r.memlockLimitBytes)} < modèle ${fmtBytes(need)} ; permanent : /etc/security/limits.conf`,
        command: "ulimit -l unlimited",
        persistence: "session",
        impact,
      });
    else
      push({
        id,
        family: "cpu",
        label,
        state: "ok",
        detail: r.memlockLimitBytes === Number.POSITIVE_INFINITY ? "illimitée" : fmtBytes(r.memlockLimitBytes),
        impact,
      });
  }
  {
    const id = "cpu.swappiness";
    const label = "vm.swappiness";
    const impact = "les poids en RAM partent en swap";
    if (r.swappiness === null) push({ id, family: "cpu", label, state: "unknown", detail: "illisible", impact });
    else if (overflow && r.swappiness > 10)
      push({
        id,
        family: "cpu",
        label,
        state: "warn",
        detail: `${r.swappiness} alors que le modèle déborde en RAM ; permanent : /etc/sysctl.d/`,
        command: "sudo sysctl vm.swappiness=10",
        persistence: "session",
        impact,
      });
    else push({ id, family: "cpu", label, state: "ok", detail: String(r.swappiness), impact });
  }
  {
    const id = "cpu.numa";
    const label = "Nœuds NUMA";
    const impact = "accès mémoire distants";
    if (ctx.cpu.numaNodes <= 1) push({ id, family: "cpu", label, state: "ok", detail: "un seul nœud", impact });
    else if (estimate?.serverArgs.includes("--numa"))
      push({
        id,
        family: "cpu",
        label,
        state: "ok",
        detail: `${ctx.cpu.numaNodes} nœuds, --numa distribute recommandé`,
        impact,
      });
    else
      push({
        id,
        family: "cpu",
        label,
        state: "warn",
        detail: `${ctx.cpu.numaNodes} nœuds sans --numa : ajouter --numa distribute au profil`,
        persistence: "permanent",
        impact,
      });
  }

  // Build llama.cpp
  {
    const id = "build.cuda";
    const label = "Backend CUDA";
    const impact = "les cartes NVIDIA ne servent pas";
    const cudaListed = ctx.devices.some((d) => d.backend === "CUDA");
    if (cudaListed) push({ id, family: "build", label, state: "ok", detail: "présent", impact });
    else if (nvidia.length === 0)
      push({ id, family: "build", label, state: "ok", detail: "pas de carte NVIDIA", impact });
    else if (r.backendLibs.length === 0)
      push({ id, family: "build", label, state: "unknown", detail: "bibliothèques du build introuvables", impact });
    else if (r.backendLibs.some((l) => l.startsWith("libggml-cuda")))
      push({ id, family: "build", label, state: "ok", detail: "présent", impact });
    else
      push({
        id,
        family: "build",
        label,
        state: "warn",
        detail: "absent : reconstruire llama.cpp avec -DGGML_CUDA=ON",
        persistence: "permanent",
        impact,
      });
  }
  {
    const id = "build.simd";
    const label = "Instructions SIMD du build";
    const impact = "calcul CPU plus lent";
    const want = ["AVX2", "AVX512"].filter((f) => ctx.cpu.flags.includes(f === "AVX2" ? "avx2" : "avx512f"));
    if (r.systemInfo === null)
      push({
        id,
        family: "build",
        label,
        state: "unknown",
        detail: "pas de system_info dans les logs : lancer le serveur d'abord",
        impact,
      });
    else {
      const missing = want.filter((f) => !new RegExp(`\\b${f} = 1\\b`).test(r.systemInfo as string));
      if (missing.length === 0)
        push({ id, family: "build", label, state: "ok", detail: want.join(", ") || "aucune", impact });
      else
        push({
          id,
          family: "build",
          label,
          state: "warn",
          detail: `${missing.join(", ")} disponible mais inutilisé : reconstruire avec -DGGML_NATIVE=ON`,
          persistence: "permanent",
          impact,
        });
    }
  }
  {
    const id = "build.age";
    const label = "Âge du build";
    const impact = "optimisations et correctifs récents absents";
    if (r.buildDate === null)
      push({ id, family: "build", label, state: "unknown", detail: "date inconnue (pas de dépôt git)", impact });
    else {
      const days = Math.floor((ctx.now - r.buildDate) / 86400_000);
      if (ctx.now - r.buildDate > OLD_BUILD_MS)
        push({
          id,
          family: "build",
          label,
          state: "warn",
          detail: `${days} jours`,
          command: "git pull && cmake --build build",
          persistence: "permanent",
          impact,
        });
      else push({ id, family: "build", label, state: "ok", detail: `${days} jours`, impact });
    }
  }

  // Noyau / disque
  {
    const id = "kernel.iommu";
    const label = "IOMMU";
    const impact = "copies entre cartes plus lentes";
    const pt =
      /\biommu=pt\b/.test(r.cmdline) || /\bamd_iommu=off\b/.test(r.cmdline) || /\bintel_iommu=off\b/.test(r.cmdline);
    if (r.iommuActive === null)
      push({ id, family: "kernel", label, state: "unknown", detail: "/sys/class/iommu illisible", impact });
    else if (!r.iommuActive || pt)
      push({ id, family: "kernel", label, state: "ok", detail: r.iommuActive ? "passthrough" : "inactif", impact });
    else if (ctx.retainedBusIds.length < 2)
      push({ id, family: "kernel", label, state: "ok", detail: "actif, une seule carte", impact });
    else
      push({
        id,
        family: "kernel",
        label,
        state: "warn",
        detail: "actif sans passthrough : ajouter iommu=pt à la cmdline du noyau (redémarrage)",
        persistence: "permanent",
        impact,
      });
  }
  {
    const id = "kernel.disk";
    const label = "Disque du modèle";
    const impact = "chargement lent";
    const d = r.modelDisk;
    if (d === null) push({ id, family: "kernel", label, state: "unknown", detail: "inconnu", impact });
    else if (d.rotational === true)
      push({
        id,
        family: "kernel",
        label,
        state: "warn",
        detail: "disque rotatif : déplacer le modèle sur un SSD local",
        persistence: "permanent",
        impact,
      });
    else if (d.fsType && NETWORK_FS.test(d.fsType))
      push({
        id,
        family: "kernel",
        label,
        state: "warn",
        detail: `${d.fsType} : déplacer le modèle sur un SSD local`,
        persistence: "permanent",
        impact,
      });
    else
      push({
        id,
        family: "kernel",
        label,
        state: "ok",
        detail: `${d.fsType ?? "?"}${d.rotational === false ? ", SSD" : ""}`,
        impact,
      });
  }
  {
    const id = "kernel.disk-speed";
    const label = "Débit du disque du modèle";
    const impact = "un modèle qui déborde la RAM lit le disque à chaque jeton";
    const d = ctx.diskSpeed;
    if (!d)
      push({
        id,
        family: "kernel",
        label,
        state: "unknown",
        detail: "non mesuré : bouton « Mesurer le disque »",
        impact,
      });
    else if (d.bytesPerSec < DISK_OK_BPS)
      push({
        id,
        family: "kernel",
        label,
        state: "warn",
        detail: `lecture séquentielle ${fmtBytes(d.bytesPerSec)}/s${overflow ? " alors que le modèle déborde" : ""}`,
        impact,
      });
    else
      push({
        id,
        family: "kernel",
        label,
        state: "ok",
        detail: `lecture séquentielle ${fmtBytes(d.bytesPerSec)}/s`,
        impact,
      });
  }
  {
    const id = "kernel.swap";
    const label = "Swap";
    const impact = "génération par à-coups";
    if (ctx.mem === null) push({ id, family: "kernel", label, state: "unknown", detail: "mémoire inconnue", impact });
    else if (overflow && ctx.mem.swapUsedBytes > 0)
      push({
        id,
        family: "kernel",
        label,
        state: "warn",
        detail: `${fmtBytes(ctx.mem.swapUsedBytes)} utilisés alors que le modèle déborde : réduire -c ou monter --n-cpu-moe`,
        impact,
      });
    else
      push({
        id,
        family: "kernel",
        label,
        state: "ok",
        detail: ctx.mem.swapUsedBytes > 0 ? `${fmtBytes(ctx.mem.swapUsedBytes)} utilisés` : "inutilisé",
        impact,
      });
  }

  return out;
}

export function summarize(checks: Check[]): { warn: number; ok: number; unknown: number; na: number } {
  const s = { warn: 0, ok: 0, unknown: 0, na: 0 };
  for (const c of checks) s[c.state]++;
  return s;
}
