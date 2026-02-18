import "ol/ol.css";
import "./style.css";
import {
  adjustPolygonAnglesToRight,
  createPolygonMap
} from "./map/createPolygonMap";

const { vectorSource } = createPolygonMap("map");

const minAngleInput = document.getElementById("minAngle") as HTMLInputElement | null;
const maxAngleInput = document.getElementById("maxAngle") as HTMLInputElement | null;
const adjustAnglesButton = document.getElementById("adjustAnglesBtn") as HTMLButtonElement | null;
const statusNode = document.getElementById("adjustStatus") as HTMLParagraphElement | null;

if (!minAngleInput || !maxAngleInput || !adjustAnglesButton || !statusNode) {
  throw new Error("Angle adjustment controls are not available in the DOM.");
}
const statusElement: HTMLParagraphElement = statusNode;

function setStatus(message: string): void {
  statusElement.textContent = message;
}

function parseAngleInput(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

adjustAnglesButton.addEventListener("click", () => {
  const rawMin = parseAngleInput(minAngleInput.value);
  const rawMax = parseAngleInput(maxAngleInput.value);
  if (rawMin === null || rawMax === null) {
    setStatus("유효한 min/max 각도를 입력하세요");
    return;
  }

  const clampedMin = Math.max(0, Math.min(360, rawMin));
  const clampedMax = Math.max(0, Math.min(360, rawMax));
  const minAngle = Math.min(clampedMin, clampedMax);
  const maxAngle = Math.max(clampedMin, clampedMax);

  minAngleInput.value = minAngle.toString();
  maxAngleInput.value = maxAngle.toString();

  // 현재 벡터 소스에 있는 모든 폴리곤에 각도 보정을 적용한다.
  const result = adjustPolygonAnglesToRight(vectorSource, minAngle, maxAngle);
  if (result.updatedVertices === 0) {
    setStatus("조건에 맞는 꼭지점 없음");
    return;
  }

  setStatus(`${result.updatedPolygons}개 폴리곤, ${result.updatedVertices}개 꼭지점 교정`);
});
