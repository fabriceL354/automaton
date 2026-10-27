/**
 * Vérifications de preuves économiques communes.
 * Logique extraite de Scout V14.6.
 *
 * Aucune requête réseau.
 * Aucune autorisation de dépense.
 */

export function quoteAppearsInReadPage(
  sourceText: string,
  quote: string
): boolean {
  return quote.length >= 16 && sourceText.includes(quote);
}

export function quotedCostMatches(
  quote: string,
  costCents: number
): boolean {
  if (!Number.isSafeInteger(costCents) || costCents < 0) {
    return false;
  }

  const amounts = [
    ...quote.matchAll(
      /\b(\d+(?:[.,]\d{1,2})?)\s*(?:EUR|euros?|€)/gi
    )
  ].map(match =>
    Math.round(Number(match[1].replace(",", ".")) * 100)
  );

  return (
    (costCents === 0 &&
      /gratuit|free|sans investissement/i.test(quote)) ||
    amounts.includes(costCents)
  );
}
