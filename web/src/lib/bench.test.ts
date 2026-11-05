import { expect, test } from "bun:test"
import { formFromSpec, specFromForm } from "./bench"

test("a -ts without -dev survives the form", () => {
  const form = formFromSpec({ modelPath: "/m/a.gguf", mmprojPath: null, profileId: null, params: { ts: [57, 50] }, serverArgs: [] })
  const built = specFromForm(form)
  expect("spec" in built && built.spec.params).toEqual({ ts: [57, 50] })
})
