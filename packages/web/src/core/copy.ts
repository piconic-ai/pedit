type Clipboard = Pick<globalThis.Clipboard, 'writeText'>

/** False where the Clipboard API is missing (not a secure context) or refused. */
export async function copyText(
  text: string,
  clipboard: Clipboard | undefined = navigator.clipboard,
): Promise<boolean> {
  try {
    if (!clipboard) return false
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
