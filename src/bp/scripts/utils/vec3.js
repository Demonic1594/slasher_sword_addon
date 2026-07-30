/**
 * @typedef {import("@minecraft/server").Vector3} Vector3
 */

// This file only exports the vector helpers actually used elsewhere in the
// addon (verified by searching every call site) — a leaner, more general
// vector-math library isn't needed here and would just be dead weight
// shipped with every script load.

export const ZERO = Object.freeze({
  x: 0,
  y: 0,
  z: 0,
});

export const UP = Object.freeze({
  x: 0,
  y: 1,
  z: 0,
});

export const DOWN = Object.freeze({
  x: 0,
  y: -1,
  z: 0,
});

export const FORWARD = Object.freeze({
  x: 0,
  y: 0,
  z: 1,
});

/**
 * Adds two vectors together.
 * @param {Vector3} vecA First vector
 * @param {Vector3} vecB Second vector
 * @returns {Vector3}
 */
export function add(vecA, vecB) {
  return {
    x: vecA.x + vecB.x,
    y: vecA.y + vecB.y,
    z: vecA.z + vecB.z,
  };
}

/**
 * Subtracts second vector from first.
 * @param {Vector3} vecA First vector
 * @param {Vector3} vecB Vector to subtract
 * @returns {Vector3}
 */
export function subtract(vecA, vecB) {
  return {
    x: vecA.x - vecB.x,
    y: vecA.y - vecB.y,
    z: vecA.z - vecB.z,
  };
}

/**
 * Scales a vector by a number.
 * @param {Vector3} vec Vector to scale
 * @param {number} scalar Scale factor
 * @returns {Vector3}
 */
export function scale(vec, scalar) {
  return {
    x: vec.x * scalar,
    y: vec.y * scalar,
    z: vec.z * scalar,
  };
}

/**
 * Calculates distance between two points.
 * @param {Vector3} vecA First point
 * @param {Vector3} vecB Second point
 * @returns {number}
 */
export function distance(vecA, vecB) {
  return Math.sqrt(
    (vecA.x - vecB.x) ** 2 + (vecA.y - vecB.y) ** 2 + (vecA.z - vecB.z) ** 2,
  );
}

/**
 * Normalizes a vector to unit length.
 * @param {Vector3} vec Input vector
 * @returns {Vector3}
 */
export function normalize(vec) {
  const len = Math.sqrt(vec.x ** 2 + vec.y ** 2 + vec.z ** 2);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: vec.x / len, y: vec.y / len, z: vec.z / len };
}

/**
 * Calculates the magnitude of a vector.
 * @param {Vector3} vec The vector
 * @returns {number}
 */
export function length(vec) {
  return Math.sqrt(vec.x ** 2 + vec.y ** 2 + vec.z ** 2);
}

/**
 * Calculates midpoint between two vectors.
 * @param {Vector3} vec1 First vector
 * @param {Vector3} vec2 Second vector
 * @returns {Vector3}
 */
export function midpoint(vec1, vec2) {
  return {
    x: (vec1.x + vec2.x) / 2,
    y: (vec1.y + vec2.y) / 2,
    z: (vec1.z + vec2.z) / 2,
  };
}

/**
 * Computes the cross product of two vectors. Kept private since the only
 * current consumer is `getRelativeToHead` below.
 * @param {Vector3} vec1 First vector
 * @param {Vector3} vec2 Second vector
 * @returns {Vector3}
 */
function cross(vec1, vec2) {
  return {
    x: vec1.y * vec2.z - vec1.z * vec2.y,
    y: vec1.z * vec2.x - vec1.x * vec2.z,
    z: vec1.x * vec2.y - vec1.y * vec2.x,
  };
}

/**
 * Changes vector direction while preserving magnitude.
 * @param {Vector3} vec Vector to change
 * @param {Vector3} dir New direction
 * @returns {Vector3}
 */
export function changeDir(vec, dir) {
  const magnitude = Math.sqrt(vec.x * vec.x + vec.y * vec.y + vec.z * vec.z);
  if (magnitude === 0) return { x: 0, y: 0, z: 0 };

  const dirMagnitude = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
  if (dirMagnitude === 0) return { x: vec.x, y: vec.y, z: vec.z };

  return {
    x: (dir.x / dirMagnitude) * magnitude,
    y: (dir.y / dirMagnitude) * magnitude,
    z: (dir.z / dirMagnitude) * magnitude,
  };
}

/**
 * Gets position relative to head location and view direction.
 * @param {Vector3} headLocation Head position
 * @param {Vector3} viewDirection View direction vector
 * @param {Partial<Vector3>} [move] Movement offset
 * @returns {Vector3}
 */
export function getRelativeToHead(headLocation, viewDirection, move) {
  const forward = viewDirection;

  // cross(forward, up) degenerates toward the zero vector whenever forward
  // is nearly parallel to world-up — i.e. aiming close to straight up or
  // straight down. Left uncorrected, `right` collapses to {0,0,0} in that
  // aim cone, which visibly collapses anything offset sideways from head
  // (e.g. the fast-atk beam's 3-way left/center/right fan) onto a single
  // point instead of fanning out. Falling back to world-forward as the
  // reference axis in that narrow case keeps the cross product well-defined.
  const up = { x: 0, y: 1, z: 0 };
  const referenceUp = Math.abs(forward.y) > 0.999 ? { x: 0, y: 0, z: 1 } : up;
  const right = normalize(cross(forward, referenceUp));

  const rightMove = move?.x ?? 0;
  const upMove = move?.y ?? 0;
  const forwardMove = move?.z ?? 0;

  const moveVec = add(
    add(scale(right, rightMove), scale(up, upMove)),
    scale(forward, forwardMove),
  );

  return add(headLocation, moveVec);
}
