const PARAGRAPH =
  "Le phare se dressait au bout de la jetée, battu par les vagues depuis plus d'un siècle. Chaque soir, le gardien montait les cent douze marches, " +
  "nettoyait la lentille, vérifiait la mèche et consignait dans son registre la direction du vent, la hauteur de la houle et les navires aperçus au large. ";

/** Un texte fixe d'environ `tokens` jetons (≈ 4 caractères chacun), identique d'un run à l'autre (copié de llama-tui). */
export function promptOf(tokens: number): string {
  const chars = tokens * 4;
  return PARAGRAPH.repeat(Math.ceil(chars / PARAGRAPH.length)).slice(0, chars);
}
