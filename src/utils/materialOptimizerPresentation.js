export function formatCutNumberLabel(cutNumbers) {
  const sortedNumbers = Array.from(
    new Set(
      cutNumbers
        .map((number) => Number(number))
        .filter((number) => Number.isFinite(number))
    )
  ).sort((a, b) => a - b);

  if (sortedNumbers.length === 0) return "-";

  const isContinuous = sortedNumbers.every(
    (number, index) => index === 0 || number === sortedNumbers[index - 1] + 1
  );

  if (isContinuous && sortedNumbers.length > 1) {
    return `${sortedNumbers[0]}-${sortedNumbers[sortedNumbers.length - 1]}`;
  }

  return sortedNumbers.join(", ");
}

export function groupCutsForDisplay(cuts, { restartAtOne = false } = {}) {
  const groups = new Map();

  (Array.isArray(cuts) ? cuts : []).forEach((cut, index) => {
    const bin = cut.binId || cut.binGroup || "";
    const key = [
      cut.workOrder || "",
      cut.furniture || "",
      cut.sku || "",
      cut.partName || "",
      cut.cutLength || 0,
      bin,
    ].join("||");

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        cutNumbers: [],
        workOrder: cut.workOrder || "",
        furniture: cut.furniture || "",
        sku: cut.sku || "",
        partName: cut.partName || "",
        cutLength: cut.cutLength || 0,
        quantity: 0,
        bin,
      });
    }

    const group = groups.get(key);
    group.cutNumbers.push(restartAtOne ? index + 1 : cut.cutNumber);
    group.quantity += Number(cut.quantity || 1);
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    cutNumberLabel: formatCutNumberLabel(group.cutNumbers),
  }));
}

export function getRawPiecePresentation(piece) {
  const stockLength = Math.max(0, Number(piece?.stockLength || 0));
  const remainingLength = Math.max(0, Number(piece?.remaining || 0));

  return {
    usedLength: Math.max(0, stockLength - remainingLength),
    remainingLength,
    kerfLoss: Math.max(0, Number(piece?.kerfLoss || 0)),
    remainderClassification:
      Number(piece?.reusableDrop || 0) > 0 ? "Reusable Drop" : "Scrap",
  };
}
