import Draw from "ol/interaction/Draw";
import Map from "ol/Map";
import View from "ol/View";
import OSM from "ol/source/OSM";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Point from "ol/geom/Point";
import { Fill, Stroke, Style, Circle as CircleStyle, Text as TextStyle } from "ol/style";
import type { Coordinate } from "ol/coordinate";
import type Feature from "ol/Feature";
import type Polygon from "ol/geom/Polygon";
import type { StyleFunction } from "ol/style/Style";

const polygonFill = new Fill({ color: "rgba(0, 153, 255, 0.22)" });
const polygonStroke = new Stroke({ color: "#005fa3", width: 2 });
const vertexMarker = new CircleStyle({
  radius: 5,
  fill: new Fill({ color: "#005fa3" }),
  stroke: new Stroke({ color: "#ffffff", width: 1.5 })
});
const angleTextFill = new Fill({ color: "#0b2a42" });
const angleTextStroke = new Stroke({ color: "#ffffff", width: 3 });
const polygonBaseStyle = new Style({
  fill: polygonFill,
  stroke: polygonStroke
});
const TARGET_ANGLE = 90;
const TARGET_TOLERANCE = 0.001;
const REGULARIZATION_WEIGHT = 1e-6;
const NUMERIC_DIFF_STEP = 1e-3;
const MAX_SOLVER_ITERATIONS = 60;
const MAX_FALLBACK_ITERATIONS = 160;

export type PolygonMapContext = {
  map: Map;
  vectorSource: VectorSource<Feature<Polygon>>;
};

type AngleAdjustResult = {
  updatedPolygons: number;
  updatedVertices: number;
};

function getRingWithoutClosure(polygon: Polygon): Coordinate[] {
  // OpenLayers 폴리곤 링은 마지막에 시작점이 한 번 더 들어간 폐합 구조다.
  // 각도 계산은 중복 꼭지점이 없는 배열에서 처리하는 것이 안정적이다.
  const outerRing = polygon.getCoordinates()[0] ?? [];
  if (outerRing.length < 2) {
    return [...outerRing];
  }

  const first = outerRing[0];
  const last = outerRing[outerRing.length - 1];
  const isClosed = first[0] === last[0] && first[1] === last[1];
  return isClosed ? outerRing.slice(0, -1) : [...outerRing];
}

function calculateInteriorAngle(
  prev: Coordinate,
  current: Coordinate,
  next: Coordinate
): number | null {
  const bax = prev[0] - current[0];
  const bay = prev[1] - current[1];
  const bcx = next[0] - current[0];
  const bcy = next[1] - current[1];

  const baLength = Math.hypot(bax, bay);
  const bcLength = Math.hypot(bcx, bcy);
  if (baLength === 0 || bcLength === 0) {
    return null;
  }

  const cosine = (bax * bcx + bay * bcy) / (baLength * bcLength);
  const clamped = Math.max(-1, Math.min(1, cosine));
  const angle = (Math.acos(clamped) * 180) / Math.PI;
  return Number.isFinite(angle) ? angle : null;
}

function createClosedRing(ring: Coordinate[]): Coordinate[] {
  if (ring.length === 0) {
    return [];
  }
  return [...ring, [...ring[0]]];
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

function moveVertexToRightAngle(
  prev: Coordinate,
  current: Coordinate,
  next: Coordinate
): Coordinate | null {
  const midX = (prev[0] + next[0]) / 2;
  const midY = (prev[1] + next[1]) / 2;
  const radius = Math.hypot(next[0] - prev[0], next[1] - prev[1]) / 2;
  if (radius === 0) {
    return null;
  }

  const toCurrentX = current[0] - midX;
  const toCurrentY = current[1] - midY;
  const toCurrentLength = Math.hypot(toCurrentX, toCurrentY);
  if (toCurrentLength > 0) {
    const scale = radius / toCurrentLength;
    return [midX + toCurrentX * scale, midY + toCurrentY * scale];
  }

  const edgeX = next[0] - prev[0];
  const edgeY = next[1] - prev[1];
  const edgeLength = Math.hypot(edgeX, edgeY);
  if (edgeLength === 0) {
    return null;
  }

  const unitPerp: Coordinate = [-edgeY / edgeLength, edgeX / edgeLength];
  const candidateA: Coordinate = [midX + unitPerp[0] * radius, midY + unitPerp[1] * radius];
  const candidateB: Coordinate = [midX - unitPerp[0] * radius, midY - unitPerp[1] * radius];
  const distanceA = Math.hypot(candidateA[0] - current[0], candidateA[1] - current[1]);
  const distanceB = Math.hypot(candidateB[0] - current[0], candidateB[1] - current[1]);
  return distanceA <= distanceB ? candidateA : candidateB;
}

function getAngleAtIndex(ring: Coordinate[], index: number): number | null {
  const length = ring.length;
  const prev = ring[(index - 1 + length) % length];
  const current = ring[index];
  const next = ring[(index + 1) % length];
  return calculateInteriorAngle(prev, current, next);
}

function collectTargetVertexIndices(ring: Coordinate[], min: number, max: number): number[] {
  const indices: number[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const interior = getAngleAtIndex(ring, index);
    if (interior === null) {
      continue;
    }
    const exterior = 360 - interior;
    if (inRange(interior, min, max) || inRange(exterior, min, max)) {
      indices.push(index);
    }
  }
  return indices;
}

function buildVariableIndexMap(ringLength: number, targetIndices: number[]): number[] {
  const selected = new Set<number>();
  for (const index of targetIndices) {
    selected.add(index);
    selected.add((index - 1 + ringLength) % ringLength);
    selected.add((index + 1) % ringLength);
  }
  return [...selected].sort((a, b) => a - b);
}

function applySolvedCoordinates(
  baseRing: Coordinate[],
  movableIndices: number[],
  variables: number[]
): Coordinate[] {
  const candidate = baseRing.map((coord) => [coord[0], coord[1]] as Coordinate);
  for (let variableIndex = 0; variableIndex < movableIndices.length; variableIndex += 1) {
    const vertexIndex = movableIndices[variableIndex];
    const x = variables[variableIndex * 2];
    const y = variables[variableIndex * 2 + 1];
    candidate[vertexIndex] = [x, y];
  }
  return candidate;
}

function computeConstraintResiduals(ring: Coordinate[], targetIndices: number[]): number[] {
  return targetIndices.map((index) => {
    const angle = getAngleAtIndex(ring, index);
    if (angle === null || !Number.isFinite(angle)) {
      return Number.NaN;
    }
    return angle - TARGET_ANGLE;
  });
}

function computeMaxAbs(values: number[]): number {
  let maxAbs = 0;
  for (const value of values) {
    const abs = Math.abs(value);
    if (abs > maxAbs) {
      maxAbs = abs;
    }
  }
  return maxAbs;
}

function sumSquares(values: number[]): number {
  return values.reduce((sum, value) => sum + value * value, 0);
}

function numericJacobian(
  variables: number[],
  residualFunction: (candidate: number[]) => number[]
): number[][] | null {
  const baseResidual = residualFunction(variables);
  if (baseResidual.some((value) => !Number.isFinite(value))) {
    return null;
  }

  const jacobian = baseResidual.map(() => new Array<number>(variables.length).fill(0));
  // 각 변수 축마다 수치 미분으로 Jacobian 열을 계산한다.
  for (let column = 0; column < variables.length; column += 1) {
    const plus = [...variables];
    const minus = [...variables];
    plus[column] += NUMERIC_DIFF_STEP;
    minus[column] -= NUMERIC_DIFF_STEP;

    const plusResidual = residualFunction(plus);
    const minusResidual = residualFunction(minus);
    if (
      plusResidual.some((value) => !Number.isFinite(value)) ||
      minusResidual.some((value) => !Number.isFinite(value))
    ) {
      return null;
    }

    for (let row = 0; row < baseResidual.length; row += 1) {
      jacobian[row][column] = (plusResidual[row] - minusResidual[row]) / (2 * NUMERIC_DIFF_STEP);
    }
  }
  return jacobian;
}

function solveLinearSystem(matrix: number[][], vector: number[]): number[] | null {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);

  // 부분 피벗팅을 포함한 Gauss-Jordan 소거로 선형계를 푼다.
  for (let pivotIndex = 0; pivotIndex < size; pivotIndex += 1) {
    let maxRow = pivotIndex;
    let maxValue = Math.abs(augmented[pivotIndex][pivotIndex]);
    for (let row = pivotIndex + 1; row < size; row += 1) {
      const value = Math.abs(augmented[row][pivotIndex]);
      if (value > maxValue) {
        maxValue = value;
        maxRow = row;
      }
    }

    if (maxValue < 1e-12) {
      return null;
    }

    if (maxRow !== pivotIndex) {
      const temp = augmented[pivotIndex];
      augmented[pivotIndex] = augmented[maxRow];
      augmented[maxRow] = temp;
    }

    const pivot = augmented[pivotIndex][pivotIndex];
    for (let column = pivotIndex; column <= size; column += 1) {
      augmented[pivotIndex][column] /= pivot;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivotIndex) {
        continue;
      }
      const factor = augmented[row][pivotIndex];
      if (factor === 0) {
        continue;
      }
      for (let column = pivotIndex; column <= size; column += 1) {
        augmented[row][column] -= factor * augmented[pivotIndex][column];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

function solveRightAngleConstraints(
  baseRing: Coordinate[],
  targetIndices: number[],
  tolerance: number
): Coordinate[] | null {
  const movableIndices = buildVariableIndexMap(baseRing.length, targetIndices);
  if (movableIndices.length === 0) {
    return null;
  }

  const initialVariables: number[] = [];
  for (const vertexIndex of movableIndices) {
    initialVariables.push(baseRing[vertexIndex][0], baseRing[vertexIndex][1]);
  }

  let variables = [...initialVariables];
  let damping = 1e-3;
  const residualFunction = (candidateVariables: number[]): number[] => {
    const candidateRing = applySolvedCoordinates(baseRing, movableIndices, candidateVariables);
    return computeConstraintResiduals(candidateRing, targetIndices);
  };

  // Levenberg-Marquardt 방식 반복:
  // 각도 오차를 줄이되 원래 형상에서의 변형도 함께 억제한다.
  for (let iteration = 0; iteration < MAX_SOLVER_ITERATIONS; iteration += 1) {
    const residual = residualFunction(variables);
    if (residual.some((value) => !Number.isFinite(value))) {
      return null;
    }
    const maxError = computeMaxAbs(residual);
    if (maxError <= tolerance) {
      return applySolvedCoordinates(baseRing, movableIndices, variables);
    }

    const jacobian = numericJacobian(variables, residualFunction);
    if (!jacobian) {
      return null;
    }

    const variableCount = variables.length;
    const residualCount = residual.length;
    const normalMatrix = Array.from({ length: variableCount }, () =>
      new Array<number>(variableCount).fill(0)
    );
    const normalVector = new Array<number>(variableCount).fill(0);

    for (let column = 0; column < variableCount; column += 1) {
      for (let row = 0; row < residualCount; row += 1) {
        normalVector[column] += jacobian[row][column] * residual[row];
      }
      normalVector[column] = -normalVector[column] - REGULARIZATION_WEIGHT * (variables[column] - initialVariables[column]);
    }

    for (let row = 0; row < variableCount; row += 1) {
      for (let column = 0; column < variableCount; column += 1) {
        let sum = 0;
        for (let residualIndex = 0; residualIndex < residualCount; residualIndex += 1) {
          sum += jacobian[residualIndex][row] * jacobian[residualIndex][column];
        }
        normalMatrix[row][column] = sum;
      }
      normalMatrix[row][row] += damping + REGULARIZATION_WEIGHT;
    }

    const delta = solveLinearSystem(normalMatrix, normalVector);
    if (!delta) {
      return null;
    }

    const candidateVariables = variables.map((value, index) => value + delta[index]);
    const candidateResidual = residualFunction(candidateVariables);
    if (candidateResidual.some((value) => !Number.isFinite(value))) {
      damping *= 10;
      continue;
    }

    const currentObjective =
      sumSquares(residual) +
      REGULARIZATION_WEIGHT *
        variables.reduce((sum, value, index) => {
          const diff = value - initialVariables[index];
          return sum + diff * diff;
        }, 0);
    const candidateObjective =
      sumSquares(candidateResidual) +
      REGULARIZATION_WEIGHT *
        candidateVariables.reduce((sum, value, index) => {
          const diff = value - initialVariables[index];
          return sum + diff * diff;
        }, 0);

    if (candidateObjective < currentObjective) {
      variables = candidateVariables;
      damping = Math.max(1e-6, damping * 0.5);
    } else {
      damping = Math.min(1e6, damping * 4);
    }
  }

  const finalRing = applySolvedCoordinates(baseRing, movableIndices, variables);
  const finalResidual = computeConstraintResiduals(finalRing, targetIndices);
  if (finalResidual.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return computeMaxAbs(finalResidual) <= tolerance ? finalRing : null;
}

function fallbackIterativeAdjust(
  baseRing: Coordinate[],
  targetIndices: number[],
  tolerance: number
): Coordinate[] | null {
  // 비선형 해석이 실패할 때 사용하는 보수적 폴백 루틴.
  const ring = baseRing.map((coord) => [coord[0], coord[1]] as Coordinate);

  for (let iteration = 0; iteration < MAX_FALLBACK_ITERATIONS; iteration += 1) {
    let changed = false;
    let maxError = 0;

    for (const index of targetIndices) {
      const prev = ring[(index - 1 + ring.length) % ring.length];
      const current = ring[index];
      const next = ring[(index + 1) % ring.length];
      const angle = calculateInteriorAngle(prev, current, next);
      if (angle === null) {
        continue;
      }

      const error = Math.abs(angle - TARGET_ANGLE);
      if (error > maxError) {
        maxError = error;
      }
      if (error <= tolerance) {
        continue;
      }

      const moved = moveVertexToRightAngle(prev, current, next);
      if (!moved) {
        continue;
      }
      ring[index] = moved;
      changed = true;
    }

    if (maxError <= tolerance) {
      return ring;
    }
    if (!changed) {
      break;
    }
  }

  let maxError = 0;
  for (const index of targetIndices) {
    const angle = getAngleAtIndex(ring, index);
    if (angle === null) {
      return null;
    }
    const error = Math.abs(angle - TARGET_ANGLE);
    if (error > maxError) {
      maxError = error;
    }
  }
  return maxError <= tolerance ? ring : null;
}

function buildVertexAngleStyles(polygon: Polygon): Style[] {
  const ring = getRingWithoutClosure(polygon);
  if (ring.length < 3) {
    return [];
  }

  const styles: Style[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const prev = ring[(index - 1 + ring.length) % ring.length];
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const angle = calculateInteriorAngle(prev, current, next);
    if (angle === null) {
      continue;
    }

    styles.push(
      new Style({
        geometry: new Point(current),
        image: vertexMarker,
        text: new TextStyle({
          text: `${angle.toFixed(1)}°`,
          offsetY: -12,
          textAlign: "center",
          textBaseline: "bottom",
          font: "12px sans-serif",
          fill: angleTextFill,
          stroke: angleTextStroke
        })
      })
    );
  }

  return styles;
}

export function adjustPolygonAnglesToRight(
  vectorSource: VectorSource<Feature<Polygon>>,
  minAngle: number,
  maxAngle: number
): AngleAdjustResult {
  const normalizedMin = Math.max(0, Math.min(360, minAngle));
  const normalizedMax = Math.max(0, Math.min(360, maxAngle));
  const rangeMin = Math.min(normalizedMin, normalizedMax);
  const rangeMax = Math.max(normalizedMin, normalizedMax);

  let updatedPolygons = 0;
  let updatedVertices = 0;

  for (const feature of vectorSource.getFeatures()) {
    const geometry = feature.getGeometry();
    if (!geometry || geometry.getType() !== "Polygon") {
      continue;
    }

    const polygon = geometry as Polygon;
    const ring = getRingWithoutClosure(polygon);
    if (ring.length < 3) {
      continue;
    }

    const targetIndices = collectTargetVertexIndices(ring, rangeMin, rangeMax);
    if (targetIndices.length === 0) {
      continue;
    }

    // 먼저 동시 제약 해법을 시도하고, 실패하면 반복 보정으로 폴백한다.
    const solvedRing =
      solveRightAngleConstraints(ring, targetIndices, TARGET_TOLERANCE) ??
      fallbackIterativeAdjust(ring, targetIndices, TARGET_TOLERANCE);

    if (!solvedRing) {
      continue;
    }

    polygon.setCoordinates([createClosedRing(solvedRing)]);
    updatedPolygons += 1;
    updatedVertices += targetIndices.length;
  }

  if (updatedPolygons > 0) {
    vectorSource.changed();
  }

  return { updatedPolygons, updatedVertices };
}

export function createPolygonMap(targetId: string): PolygonMapContext {
  const targetElement = document.getElementById(targetId);
  if (!targetElement) {
    throw new Error(`Map target element not found: #${targetId}`);
  }

  const vectorSource = new VectorSource<Feature<Polygon>>();
  const styleFunction: StyleFunction = (feature) => {
    const geometry = feature.getGeometry();
    if (!geometry || geometry.getType() !== "Polygon") {
      return [polygonBaseStyle];
    }

    const polygon = geometry as Polygon;
    return [polygonBaseStyle, ...buildVertexAngleStyles(polygon)];
  };

  const vectorLayer = new VectorLayer({
    source: vectorSource,
    style: styleFunction
  });

  const map = new Map({
    target: targetElement,
    layers: [
      new TileLayer({
        source: new OSM()
      }),
      vectorLayer
    ],
    view: new View({
      center: [0, 0],
      zoom: 2
    })
  });

  const draw = new Draw({
    source: vectorSource,
    type: "Polygon"
  });

  draw.on("drawstart", (event) => {
    const feature = event.feature as Feature<Polygon>;
    feature.set("createdAt", new Date().toISOString());
  });

  draw.on("drawend", (event) => {
    const feature = event.feature as Feature<Polygon>;
    const polygon = feature.getGeometry();
    const ringCount = polygon ? polygon.getCoordinates().length : 0;
    const validAngleCount = polygon ? buildVertexAngleStyles(polygon).length : 0;
    console.log("Polygon created", {
      ringCount,
      pointCount: polygon ? polygon.getCoordinates()[0]?.length ?? 0 : 0,
      validAngleCount,
      createdAt: feature.get("createdAt")
    });
  });

  map.addInteraction(draw);
  return { map, vectorSource };
}
