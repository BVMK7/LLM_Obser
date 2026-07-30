import { useState } from "react";

// Self-contained clipboard copy button — manages its own "Copied ✓" flash
// so callers don't need to plumb any state through for it.
export default function CopyButton({ text, className = "" }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions/insecure context) — this is a
      // convenience action, so fail silently rather than surfacing an error.
    }
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      className={`text-[10px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors ${className}`}
    >
      {copied ? "Copied ✓" : "Copy"}
    </button>
  );
}
