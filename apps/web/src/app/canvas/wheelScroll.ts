// P31: map horizontal wheel intent to scrollLeft; vertical wheel stays with xterm.
export type WheelLike = { deltaX: number; deltaY: number; shiftKey: boolean; deltaMode?: number };
export const horizontalWheelDelta = (e: WheelLike): number => {
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  if (e.deltaX !== 0 && Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return e.deltaX * scale;
  if (e.shiftKey && e.deltaY !== 0) return e.deltaY * scale;
  return 0;
};
