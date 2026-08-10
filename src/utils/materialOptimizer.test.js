import test from "node:test";
import assert from "node:assert/strict";

import {
  MATERIAL_OPTIMIZER_DEFAULT_KERF,
  buildMaterialOptimizerPlan,
  formatOptimizerInches,
} from "./materialOptimizer.js";
import {
  getRawPiecePresentation,
  groupCutsForDisplay,
} from "./materialOptimizerPresentation.js";

const optimizerOptions = {
  kerf: MATERIAL_OPTIMIZER_DEFAULT_KERF,
  reusableDropThreshold: 9,
};

function makeJob(parts) {
  return {
    id: "optimizer-regression-job",
    furniture: "Regression Fixture",
    sku: "TEST-001",
    qtyNeeded: 1,
    qtyComplete: 0,
    partsSnapshot: parts,
  };
}

function makePart(name, length, qty, material = "2.5x1.25") {
  return { name, length: `${length} in`, qty, material };
}

function assertNearlyEqual(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 0.000001, `${actual} !== ${expected}`);
}

test("raw-piece presentation separates remaining scrap from kerf loss", () => {
  const examples = [
    {
      parts: [makePart("24-inch part", 24, 9), makePart("22-inch part", 22, 1)],
      expectedPhysicalLength: 238,
      expectedUsed: 239.125,
      expectedRemaining: 0.875,
      expectedMaterialLoss: 2,
    },
    {
      parts: [makePart("24-inch part", 24, 1), makePart("23-inch part", 23, 9)],
      expectedPhysicalLength: 231,
      expectedUsed: 232.125,
      expectedRemaining: 7.875,
      expectedMaterialLoss: 9,
    },
  ];

  examples.forEach((example) => {
    const plan = buildMaterialOptimizerPlan(
      [makeJob(example.parts)],
      "maximum",
      "currentWeek",
      optimizerOptions
    );
    const piece = plan.groups[0].pieces[0];
    const presentation = getRawPiecePresentation(piece);
    const physicalLength = piece.cuts.reduce(
      (sum, cut) => sum + Number(cut.cutLength || 0),
      0
    );

    assert.equal(plan.groups[0].pieces.length, 1);
    assertNearlyEqual(physicalLength, example.expectedPhysicalLength);
    assertNearlyEqual(presentation.kerfLoss, 1.125);
    assertNearlyEqual(presentation.usedLength, example.expectedUsed);
    assertNearlyEqual(presentation.remainingLength, example.expectedRemaining);
    assert.equal(presentation.remainderClassification, "Scrap");
    assert.equal(formatOptimizerInches(presentation.usedLength), String(example.expectedUsed.toFixed(2)));
    assert.equal(
      formatOptimizerInches(presentation.remainingLength),
      String(example.expectedRemaining.toFixed(2))
    );
    assert.equal(formatOptimizerInches(presentation.kerfLoss), "1.13");
    assertNearlyEqual(piece.scrap, example.expectedMaterialLoss);
    assertNearlyEqual(piece.scrap, presentation.remainingLength + presentation.kerfLoss);
    assertNearlyEqual(plan.scrap, piece.scrap);
    assert.equal(plan.reusableDrops, 0);
  });
});

test("a physical remainder meeting the plan threshold is labeled as a reusable drop", () => {
  const presentation = getRawPiecePresentation({
    stockLength: 240,
    remaining: 10.5,
    kerfLoss: 1,
    reusableDrop: 10.5,
  });

  assert.equal(presentation.remainderClassification, "Reusable Drop");
  assert.equal(presentation.remainingLength, 10.5);
  assert.equal(presentation.kerfLoss, 1);
});

test("packet cut labels restart at one for every raw piece", () => {
  const sharedFields = {
    workOrder: "JOB-001",
    furniture: "Regression Fixture",
    sku: "TEST-001",
    quantity: 1,
    binGroup: "Bin A",
  };
  const firstPieceCuts = [
    ...Array.from({ length: 9 }, (_, index) => ({
      ...sharedFields,
      id: `first-24-${index}`,
      partName: "24-inch part",
      cutLength: 24,
      cutNumber: index + 1,
    })),
    {
      ...sharedFields,
      id: "first-22",
      partName: "22-inch part",
      cutLength: 22,
      cutNumber: 10,
    },
  ];
  const secondPieceCuts = [
    {
      ...sharedFields,
      id: "second-24",
      partName: "24-inch part",
      cutLength: 24,
      cutNumber: 11,
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      ...sharedFields,
      id: `second-23-${index}`,
      partName: "23-inch part",
      cutLength: 23,
      cutNumber: index + 12,
    })),
  ];

  assert.deepEqual(
    groupCutsForDisplay(firstPieceCuts, { restartAtOne: true }).map(
      (group) => group.cutNumberLabel
    ),
    ["1-9", "10"]
  );
  assert.deepEqual(
    groupCutsForDisplay(secondPieceCuts, { restartAtOne: true }).map(
      (group) => group.cutNumberLabel
    ),
    ["1", "2-10"]
  );
  assert.deepEqual(
    groupCutsForDisplay(secondPieceCuts).map((group) => group.cutNumberLabel),
    ["11", "12-20"]
  );
});

test("global required cuts equal the sum of all material-specific cuts", () => {
  const plan = buildMaterialOptimizerPlan(
    [
      makeJob([
        makePart("Material A part", 1, 370, "2.5x1.25"),
        makePart("Material B part", 1, 150, "1x4"),
      ]),
    ],
    "maximum",
    "currentWeek",
    optimizerOptions
  );
  const cutsByMaterial = Object.fromEntries(
    plan.groups.map((group) => [group.materialType, group.totalCuts])
  );

  assert.equal(plan.totalParts, 520);
  assert.equal(cutsByMaterial["2.5x1.25"], 370);
  assert.equal(cutsByMaterial["1x4"], 150);
  assert.equal(
    plan.groups.reduce((sum, group) => sum + group.totalCuts, 0),
    plan.totalParts
  );
  assert.equal(
    plan.groups.reduce((sum, group) => sum + group.pieces.length, 0),
    plan.rawPiecesRequired
  );
  assertNearlyEqual(
    plan.groups.flatMap((group) => group.pieces).reduce(
      (sum, piece) =>
        sum +
        Number(piece.kerfLoss || 0) +
        (Number(piece.reusableDrop || 0) > 0 ? 0 : Number(piece.remaining || 0)),
      0
    ),
    plan.scrap
  );
  assertNearlyEqual(
    plan.groups.flatMap((group) => group.pieces).reduce(
      (sum, piece) => sum + Number(piece.reusableDrop || 0),
      0
    ),
    plan.reusableDrops
  );
  assert.equal(plan.projectedInventoryImpact.shortages.length, 2);
  assert.equal(plan.totalParts, 520);
});
