// The company HTTP viewer may not expose navigator.clipboard. Keep a user-click
// copy path there without sending text to another service or retaining it.
export async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // A browser permission rejection may still allow a selected-text copy.
  }
  const active = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy"))
      throw new Error("浏览器阻止了复制，请允许剪贴板权限后重试。");
  } finally {
    input.remove();
    if (active instanceof HTMLElement && active.isConnected)
      active.focus({ preventScroll: true });
  }
}
