// Checks that the panel applies the published site frame and its inverse.

import { expect, test } from "vitest";
import { PlanFrame } from "../src/site-frame";
import { siteFrameData } from "./site-frame-fixture";

const HAND_MADE = PlanFrame.fromSite({
  origin: [5, 52],
  bearing_deg: 0,
  unit_m: 0.025,
  units_per_step: 4,
  to_lattice: [
    [2, 1],
    [-1, 3],
  ],
});

test("toLatticeUnits applies the matrix", () => {
  const [x, y] = HAND_MADE.toLatticeUnits([5.5, 52.25]);
  expect(x).toBeCloseTo(1.25, 12);
  expect(y).toBeCloseTo(0.25, 12);
});

test("fromLattice inverts it", () => {
  const turned = PlanFrame.fromSite(siteFrameData([4.9, 52], 30));
  // A double near 5 degrees resolves about 1e-8 lattice units, so the real frame gets a looser bound.
  for (const [frame, tolerance] of [[HAND_MADE, 1e-9], [turned, 1e-6]] as [PlanFrame, number][]) {
    for (const point of [[0, 0], [1, 2], [-160, 120], [4000, -3000.5]] as [number, number][]) {
      const [x, y] = frame.toLatticeUnits(frame.fromLattice(point));
      expect(Math.abs(x - point[0])).toBeLessThan(tolerance);
      expect(Math.abs(y - point[1])).toBeLessThan(tolerance);
    }
  }
});

test("toLattice rounds each coordinate", () => {
  expect(HAND_MADE.toLattice(HAND_MADE.fromLattice([3.4, -2.6]))).toEqual([3, -3]);
  expect(HAND_MADE.toLattice(HAND_MADE.fromLattice([3.6, 7.2]))).toEqual([4, 7]);
});
