export const MATERIAL_OPTIMIZER_MODES = {
  standard: {
    label: "Standard",
    description:
      "Keeps each furniture/job mostly together. Easiest to cut and organize. May use more raw material.",
  },
  balanced: {
    label: "Balanced",
    description:
      "Default mode. Groups compatible parts when savings are meaningful while keeping work orders, furniture, and bins organized.",
  },
  maximum: {
    label: "Maximum Savings",
    description:
      "Most aggressive material savings. May mix parts across more jobs and requires strong labeling/bin control.",
  },
};

export const MATERIAL_OPTIMIZER_STOCK_LENGTH = 240;
export const MATERIAL_OPTIMIZER_DEFAULT_KERF = 0.125;
export const MATERIAL_OPTIMIZER_REUSABLE_DROP = 9;

export const FABRICATION_PLANNING_STEPS = [
  {
    key: "cutLayouts",
    label: "Cut Layouts",
    description: "Optimized raw-stock layouts grouped by material type.",
  },
  {
    key: "reusableInventory",
    label: "Reusable Inventory",
    description: "Drops large enough to label, store, and reuse on future jobs.",
  },
  {
    key: "purchasingForecast",
    label: "Purchasing Forecast",
    description: "Material demand forecast from planned raw pieces and expected waste.",
  },
  {
    key: "printableCutSheets",
    label: "Printable Cut Sheets",
    description: "Print-ready plan packages for fabrication review.",
  },
  {
    key: "fabricationBins",
    label: "Fabrication Bins",
    description: "Bin manifests that keep cut parts tied to jobs, furniture, and SKUs.",
  },
];

export function formatOptimizerInches(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number)
    ? String(number)
    : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function parseCutLength(value) {
  const match = String(value || "").match(/[0-9]+(?:\.[0-9]+)?/);
  const length = match ? Number(match[0]) : 0;
  return Number.isFinite(length) && length > 0 ? length : 0;
}

function getOptimizerSettings(options = {}) {
  const reusableDropThreshold = Number(options.reusableDropThreshold);
  const kerf = Number(options.kerf);

  return {
    reusableDropThreshold:
      Number.isFinite(reusableDropThreshold) && reusableDropThreshold >= 0
        ? reusableDropThreshold
        : MATERIAL_OPTIMIZER_REUSABLE_DROP,
    kerf:
      Number.isFinite(kerf) && kerf >= 0
        ? kerf
        : MATERIAL_OPTIMIZER_DEFAULT_KERF,
  };
}

function getItemSpecs(item) {
  const specs = item?.specs || {};

  return {
    sku: item?.sku || specs.sku || "",
    material: item?.material || specs.material || "",
  };
}

function getWorkOrderLabel(job, index) {
  const noteMatch = String(job?.notes || "").match(/\b(?:WO|SO|JOB)[-:\s]*[A-Z0-9-]+/i);
  if (noteMatch) return noteMatch[0].replace(/\s+/g, "-").toUpperCase();
  if (job?.workOrder || job?.workOrderNumber || job?.orderNumber) {
    return String(job.workOrder || job.workOrderNumber || job.orderNumber);
  }
  return `JOB-${String(index + 1).padStart(3, "0")}`;
}

export function normalizeMaterialCutItems(jobs) {
  const cuts = [];

  (Array.isArray(jobs) ? jobs : []).forEach((job, jobIndex) => {
    const specs = getItemSpecs(job);
    const parts = Array.isArray(job?.partsSnapshot)
      ? job.partsSnapshot
      : Array.isArray(job?.parts)
        ? job.parts
        : [];
    const remainingQty =
      Math.max(0, Number(job?.qtyNeeded || job?.qty || 1) - Number(job?.qtyComplete || 0)) ||
      Number(job?.qtyNeeded || job?.qty || 1) ||
      1;
    const workOrder = getWorkOrderLabel(job, jobIndex);
    const furniture = job?.furniture || job?.name || "Unassigned Furniture";
    const sku = job?.sku || specs.sku || "";
    const jobKey = `${workOrder}-${furniture}-${sku || job?.id || jobIndex}`;

    parts.forEach((part, partIndex) => {
      const cutLength = parseCutLength(part?.length);
      if (!cutLength) return;

      const partQty = Math.max(1, Math.round(Number(part?.qty || 1)));
      const totalQty = Math.max(1, Math.round(partQty * remainingQty));
      const materialType =
        part?.tube || part?.material || specs.material || job?.material || "Unspecified Material";

      for (let count = 0; count < totalQty; count += 1) {
        cuts.push({
          id: `${job?.id || jobIndex}-${part?.id || partIndex}-${count}`,
          workOrder,
          jobId: job?.id || jobKey,
          jobKey,
          furniture,
          sku,
          partName: part?.name || `Part ${partIndex + 1}`,
          materialType,
          cutLength,
          quantity: 1,
          sourceQty: totalQty,
          binGroup: "",
        });
      }
    });
  });

  return cuts;
}

export function sortMaterialCuts(cuts, mode = "balanced") {
  return [...cuts].sort((a, b) => {
    if (mode === "maximum") {
      const lengthCompare = b.cutLength - a.cutLength;
      if (lengthCompare !== 0) return lengthCompare;
    }

    const groupCompare = `${a.workOrder}|${a.furniture}`.localeCompare(
      `${b.workOrder}|${b.furniture}`
    );
    if (groupCompare !== 0) return groupCompare;

    return b.cutLength - a.cutLength;
  });
}

export function packMaterialCuts(cuts, mode = "balanced", options = {}) {
  const settings = getOptimizerSettings(options);
  const pieces = [];

  sortMaterialCuts(cuts, mode).forEach((cut) => {
    let bestPieceIndex = -1;
    let bestRemaining = Infinity;

    pieces.forEach((piece, index) => {
      const cutKerf = piece.cuts.length > 0 ? settings.kerf : 0;
      const needed = cut.cutLength + cutKerf;
      const remainingAfterCut = piece.remaining - needed;

      if (remainingAfterCut >= -0.001 && remainingAfterCut < bestRemaining) {
        bestPieceIndex = index;
        bestRemaining = remainingAfterCut;
      }
    });

    if (bestPieceIndex === -1) {
      pieces.push({
        rawNumber: pieces.length + 1,
        stockLength: MATERIAL_OPTIMIZER_STOCK_LENGTH,
        remaining: MATERIAL_OPTIMIZER_STOCK_LENGTH - cut.cutLength,
        kerfLoss: 0,
        cuts: [{ ...cut }],
      });
      return;
    }

    pieces[bestPieceIndex].kerfLoss += settings.kerf;
    pieces[bestPieceIndex].remaining = bestRemaining;
    pieces[bestPieceIndex].cuts.push({ ...cut });
  });

  return pieces;
}

function finalizePieces(pieces, options = {}) {
  const settings = getOptimizerSettings(options);

  return pieces.map((piece, pieceIndex) => ({
    ...piece,
    rawNumber: pieceIndex + 1,
    reusableDrop: piece.remaining >= settings.reusableDropThreshold ? piece.remaining : 0,
    scrap:
      Number(piece.kerfLoss || 0) +
      (piece.remaining < settings.reusableDropThreshold ? Math.max(0, piece.remaining) : 0),
  }));
}

function getClusteredPieces(cuts, options = {}) {
  const clusters = Object.values(
    cuts.reduce((acc, cut) => {
      if (!acc[cut.jobKey]) acc[cut.jobKey] = [];
      acc[cut.jobKey].push(cut);
      return acc;
    }, {})
  );

  return clusters.flatMap((clusterCuts) => packMaterialCuts(clusterCuts, "standard", options));
}

function getReusableDropTotal(pieces, options = {}) {
  const settings = getOptimizerSettings(options);

  return pieces.reduce(
    (sum, piece) => sum + (piece.remaining >= settings.reusableDropThreshold ? piece.remaining : 0),
    0
  );
}

function shouldUseBalancedMix(standardPieces, mixedPieces, options = {}) {
  const settings = getOptimizerSettings(options);

  if (mixedPieces.length < standardPieces.length) return true;
  if (mixedPieces.length > standardPieces.length) return false;

  const standardDrop = getReusableDropTotal(standardPieces, settings);
  const mixedDrop = getReusableDropTotal(mixedPieces, settings);
  return mixedDrop - standardDrop >= settings.reusableDropThreshold;
}

function assignBinLabels(groups) {
  const binMap = new Map();
  let binIndex = 0;
  const binLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

  groups.forEach((group) => {
    group.pieces.forEach((piece) => {
      piece.cuts = piece.cuts.map((cut) => {
        const key = [
          cut.workOrder || "",
          cut.furniture || "",
          cut.sku || "",
        ].join("||");

        if (!binMap.has(key)) {
          const label = `Bin ${binLetters[binIndex % binLetters.length]}${
            binIndex >= binLetters.length ? Math.floor(binIndex / binLetters.length) + 1 : ""
          }`;

          binMap.set(key, {
            key,
            binId: label.replace(/\s+/g, "-").toUpperCase(),
            label,
            mixed: false,
            materialType: group.materialType,
            materialTypes: [group.materialType],
            rawPieces: [],
            furniture: cut.furniture || "Furniture",
            sku: cut.sku || "",
            workOrder: cut.workOrder || "Job",
            description: `${cut.workOrder || "Job"} / ${cut.furniture || "Furniture"}${cut.sku ? ` / ${cut.sku}` : ""}`,
          });
          binIndex += 1;
        }

        const bin = binMap.get(key);
        if (!bin.rawPieces.includes(piece.rawNumber)) bin.rawPieces.push(piece.rawNumber);
        const materialType = group.materialType || cut.materialType || "";
        if (materialType && !bin.materialTypes.includes(materialType)) {
          bin.materialTypes.push(materialType);
          bin.materialType = bin.materialTypes.join(", ");
        }

        return {
          ...cut,
          binId: bin.binId,
          binGroup: bin.label,
          binDescription: bin.description,
        };
      });
    });
  });

  return Array.from(binMap.values());
}

function buildReusableMaterialInventory(groups) {
  return groups.flatMap((group) =>
    group.pieces
      .filter((piece) => piece.reusableDrop > 0)
      .map((piece) => ({
        id: `${group.materialType}-${piece.rawNumber}-drop`,
        materialType: group.materialType,
        rawPiece: piece.rawNumber,
        length: piece.reusableDrop,
        label: `${group.materialType} Drop ${formatOptimizerInches(piece.reusableDrop)} in`,
        source: `Raw Piece #${piece.rawNumber}`,
        status: "Preview",
      }))
  );
}

function buildPurchasingForecast(groups) {
  return groups.map((group) => {
    const plannedCutLength = group.pieces.reduce(
      (pieceSum, piece) =>
        pieceSum + piece.cuts.reduce((cutSum, cut) => cutSum + cut.cutLength, 0),
      0
    );

    return {
      materialType: group.materialType,
      rawStockLength: group.stockLength,
      rawPiecesRequired: group.pieces.length,
      plannedCutLength,
      reusableDrops: group.reusableDrops,
      scrap: group.scrap,
      forecastStatus: "Needs inventory count",
      purchasePieces: group.pieces.length,
    };
  });
}

function buildPrintableCutSheets(groups, mode, source) {
  return groups.map((group) => ({
    id: `${group.materialType}-cut-sheet`,
    title: `${group.materialType} Cut Sheet`,
    materialType: group.materialType,
    mode,
    source,
    rawPieces: group.pieces.length,
    totalCuts: group.totalCuts,
    cutNumbers: group.pieces.flatMap((piece) => piece.cuts.map((cut) => cut.cutNumber)),
    status: "Preview only",
  }));
}

function buildFabricationBins(groups, bins) {
  return bins.map((bin) => {
    const cuts = groups.flatMap((group) =>
      group.pieces.flatMap((piece) =>
        piece.cuts
          .filter((cut) => cut.binGroup === bin.label)
          .map((cut) => ({
            cutNumber: cut.cutNumber,
            binId: cut.binId,
            binGroup: cut.binGroup,
            workOrder: cut.workOrder,
            furniture: cut.furniture,
            sku: cut.sku,
            partName: cut.partName,
            materialType: cut.materialType,
            cutLength: cut.cutLength,
          }))
      )
    );

    return {
      ...bin,
      cutCount: cuts.length,
      materialTypes: Array.from(new Set(cuts.map((cut) => cut.materialType))),
      workOrders: Array.from(new Set(cuts.map((cut) => cut.workOrder))),
      cuts,
      status: "Preview",
    };
  });
}

function normalizeMaterialKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s*[x×]\s*/g, "x")
    .replace(/\s+/g, "")
    .trim();
}

function buildProjectedInventoryImpact(groups, options = {}) {
  const rawStockInventory = Array.isArray(options.rawStockInventory) ? options.rawStockInventory : [];
  const reusableDropInventory = Array.isArray(options.reusableDropInventory) ? options.reusableDropInventory : [];
  const cutsByMaterial = groups.reduce((acc, group) => {
    acc[group.materialType] = group.pieces.flatMap((piece) => piece.cuts);
    return acc;
  }, {});

  const reusableDropsUsed = [];
  const rawStockUsed = [];
  const shortages = [];

  const newReusableDrops = groups.flatMap((group) =>
    group.pieces
      .filter((piece) => Number(piece.reusableDrop || 0) > 0)
      .map((piece) => ({
        materialType: group.materialType,
        length: piece.reusableDrop,
        source: `Raw Piece #${piece.rawNumber}`,
      }))
  );

  Object.entries(cutsByMaterial).forEach(([materialType, materialCuts]) => {
    const materialKey = normalizeMaterialKey(materialType);
    const availableDrops = reusableDropInventory
      .filter(
        (drop) =>
          String(drop.status || "Available") === "Available" &&
          normalizeMaterialKey(drop.materialType) === materialKey &&
          Number(drop.length || 0) > 0
      )
      .map((drop) => ({ ...drop, remainingLength: Number(drop.length || 0) }))
      .sort((a, b) => a.remainingLength - b.remainingLength);
    const availableRaw = rawStockInventory
      .filter(
        (item) =>
          normalizeMaterialKey(item.materialType) === materialKey &&
          Number(item.quantityOnHand || 0) > 0
      )
      .reduce((sum, item) => sum + Number(item.quantityOnHand || 0), 0);
    let projectedRawUsed = groups.find((group) => group.materialType === materialType)?.pieces.length || 0;

    [...materialCuts]
      .sort((a, b) => b.cutLength - a.cutLength)
      .forEach((cut) => {
        const drop = availableDrops.find((item) => item.remainingLength >= cut.cutLength);
        if (!drop) return;

        drop.remainingLength -= cut.cutLength;
        reusableDropsUsed.push({
          id: drop.id || `${drop.materialType}-${drop.length}`,
          materialType,
          originalLength: Number(drop.length || 0),
          projectedRemaining: drop.remainingLength,
          cutLength: cut.cutLength,
          partName: cut.partName,
          furniture: cut.furniture,
          sku: cut.sku,
        });
        projectedRawUsed = Math.max(0, projectedRawUsed - 1);
      });

    rawStockUsed.push({
      materialType,
      projectedPiecesUsed: projectedRawUsed,
      availablePieces: availableRaw,
      projectedRemaining: Math.max(0, availableRaw - projectedRawUsed),
    });

    if (projectedRawUsed > availableRaw) {
      shortages.push({
        materialType,
        shortagePieces: projectedRawUsed - availableRaw,
      });
    }
  });

  return {
    previewOnly: true,
    note: "Preview only - inventory is not deducted until plan approval/release.",
    rawStockUsed,
    reusableDropsUsed,
    newReusableDrops,
    materialLoss: groups.reduce((sum, group) => sum + Number(group.scrap || 0), 0),
    remainingProjectedInventory: rawStockUsed,
    shortages,
    workflow: [
      "Generate Plan",
      "Reserve Material",
      "Approve Plan",
      "Release to Fabrication",
      "Subtract full raw stock and drops from inventory",
      "Add newly created reusable drops back into inventory",
    ],
  };
}

export function buildMaterialOptimizerPlan(jobs, mode = "balanced", source = "currentWeek", options = {}) {
  const settings = getOptimizerSettings(options);
  const cuts = normalizeMaterialCutItems(jobs);
  const materialBuckets = cuts.reduce((acc, cut) => {
    const key = cut.materialType || "Unspecified Material";
    if (!acc[key]) acc[key] = [];
    acc[key].push(cut);
    return acc;
  }, {});

  const groups = Object.entries(materialBuckets).map(([materialType, materialCuts]) => {
    const standardPieces = finalizePieces(getClusteredPieces(materialCuts, settings), settings);
    const balancedPieces = finalizePieces(packMaterialCuts(materialCuts, "balanced", settings), settings);
    const mixedPieces = finalizePieces(packMaterialCuts(materialCuts, "maximum", settings), settings);
    const plannedPieces =
      mode === "standard"
        ? standardPieces
        : mode === "maximum"
          ? mixedPieces
          : shouldUseBalancedMix(standardPieces, balancedPieces, settings)
            ? balancedPieces
            : standardPieces;

    return {
      materialType,
      stockLength: MATERIAL_OPTIMIZER_STOCK_LENGTH,
      totalCuts: materialCuts.length,
      pieces: finalizePieces(plannedPieces, settings),
      standardPieceCount: standardPieces.length,
      mixed: plannedPieces !== standardPieces,
      saved: Math.max(0, (standardPieces.length - plannedPieces.length) * MATERIAL_OPTIMIZER_STOCK_LENGTH),
    };
  });

  const bins = assignBinLabels(groups);
  let cutNumber = 1;

  groups.forEach((group) => {
    group.pieces.forEach((piece) => {
      piece.cuts = piece.cuts.map((cut) => ({
        ...cut,
        cutNumber: cutNumber++,
      }));
    });

    group.reusableDrops = group.pieces.reduce((sum, piece) => sum + piece.reusableDrop, 0);
    group.scrap = group.pieces.reduce((sum, piece) => sum + piece.scrap, 0);
    group.waste = group.scrap;
  });

  const fabricationBins = buildFabricationBins(groups, bins);
  const reusableInventory = buildReusableMaterialInventory(groups);
  const purchasingForecast = buildPurchasingForecast(groups);
  const printableCutSheets = buildPrintableCutSheets(groups, mode, source);
  const projectedInventoryImpact = buildProjectedInventoryImpact(groups, options);

  return {
    planType: "fabricationPlanningPreview",
    planVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    source,
    settings,
    selectedJobs: Array.isArray(jobs) ? jobs.length : 0,
    totalParts: cuts.length,
    materialTypes: groups.length,
    rawPiecesRequired: groups.reduce((sum, group) => sum + group.pieces.length, 0),
    estimatedSaved: groups.reduce((sum, group) => sum + group.saved, 0),
    reusableDrops: groups.reduce((sum, group) => sum + group.reusableDrops, 0),
    scrap: groups.reduce((sum, group) => sum + group.scrap, 0),
    groups,
    bins,
    cutLayouts: groups,
    reusableInventory,
    purchasingForecast,
    printableCutSheets,
    fabricationBins,
    projectedInventoryImpact,
    planningSteps: FABRICATION_PLANNING_STEPS,
  };
}
