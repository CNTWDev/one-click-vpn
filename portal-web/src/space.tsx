import { memo } from "react";

/**
 * Behind every Portal page (same language as the apps): a dark warm ground, one soft lamp from above (being seen),
 * fine film grain and four crop marks at the corners of the window, as if the page were a sheet in a file.
 * CSS only, never takes clicks; the grain is a tiny inline SVG noise tile.
 */
export const Backdrop = memo(function Backdrop() {
  return <div className="backdrop" aria-hidden="true">
    <span className="backdrop-lamp" /><span className="backdrop-grain" />
    <span className="crop tl" /><span className="crop tr" /><span className="crop bl" /><span className="crop br" />
  </div>;
});
