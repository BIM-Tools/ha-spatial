// Checks the rules of the address search card that need no map: when a query may go, how a result reads, where the map goes.
import { expect, test } from "vitest";
import { BUILDING_ZOOM, type Place, cameraFor, canSearch, homeUnknown, placeLines } from "../src/address";

test.each([
  ["", false],
  ["ab", false],
  ["  ab  ", false],
  ["abc", true],
  [" Voorbeeldstraat 12 ", true],
  ["x".repeat(200), true],
  ["x".repeat(201), false],
])("a query of %j may be searched: %s", (query, allowed) => {
  expect(canSearch(query)).toBe(allowed);
});

test.each([
  [{}, true],
  [{ latitude: 0, longitude: 0 }, true],
  [{ latitude: null, longitude: 5 }, true],
  [{ latitude: 0, longitude: 5 }, false],
  [{ latitude: 52, longitude: 5 }, false],
])("home location %j is unknown: %s", (config, unknown) => {
  expect(homeUnknown(config)).toBe(unknown);
});

test.each([
  ["12, Voorbeeldstraat, Voorbeeldwijk, Ergens, Voorbeeldland", "Voorbeeldstraat 12", "Voorbeeldwijk, Ergens, Voorbeeldland"],
  ["12a, Voorbeeldstraat, Ergens", "Voorbeeldstraat 12a", "Ergens"],
  ["12-14, Example Road, Exampletown", "Example Road 12-14", "Exampletown"],
  ["Voorbeeldstraat, Ergens, Voorbeeldland", "Voorbeeldstraat", "Ergens, Voorbeeldland"],
  ["Example Hall, 1, Example Square, Exampletown", "Example Hall", "1, Example Square, Exampletown"],
  ["Domtoren, Domplein, Utrecht", "Domtoren", "Domplein, Utrecht"],
  ["Ergens", "Ergens", ""],
  [" 3 ,  Example Street ,, Exampletown ", "Example Street 3", "Exampletown"],
])("result %j reads %j over %j", (label, street, town) => {
  expect(placeLines(label)).toEqual({ street, town });
});

const place = (bbox: Place["bbox"]): Place => ({ label: "", lat: 52, lon: 5, bbox });

test.each([
  ["a box", [4.9, 51.9, 5.1, 52.1], { bounds: [[4.9, 51.9], [5.1, 52.1]], maxZoom: BUILDING_ZOOM }],
  ["no box", null, { center: [5, 52], zoom: BUILDING_ZOOM }],
  ["a box without width", [5, 51.9, 5, 52.1], { center: [5, 52], zoom: BUILDING_ZOOM }],
  ["a box without height", [4.9, 52, 5.1, 52], { center: [5, 52], zoom: BUILDING_ZOOM }],
  ["a box across the antimeridian", [179, -1, -179, 1], { center: [5, 52], zoom: BUILDING_ZOOM }],
] as const)("a place with %s takes the map to %j", (_, bbox, camera) => {
  expect(cameraFor(place(bbox as Place["bbox"]))).toEqual(camera);
});
