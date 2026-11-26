export const sumKnown = values => {
  const known = values.filter(Number.isFinite);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
};
export const reading = (value, digits = 0, unit = "") => Number.isFinite(value) ? `${value.toFixed(digits)}${unit}` : "\u2014";
