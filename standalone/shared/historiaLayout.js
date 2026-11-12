export function clampHistoriaSplit(value,width=1000) {
  const available=Math.max(600,Number(width)||1000);
  return Math.min(Math.min(70,100-370/available*100),Math.max(Math.max(20,240/available*100),Number(value)||35));
}
