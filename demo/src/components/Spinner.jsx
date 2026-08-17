// Inline spinner for buttons, so a wallet round-trip doesn't look like a hang.
export default function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
