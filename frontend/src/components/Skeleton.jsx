// Pulsing placeholder block shown while a page's initial data fetch is in
// flight, instead of leaving blank space where the real layout will appear.
export default function Skeleton({ className = "" }) {
  return <div className={`animate-pulse bg-white/5 rounded ${className}`} />;
}
