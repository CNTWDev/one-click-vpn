import { BrandMark, BrandWordmark } from "../../shared/brand";
import { useSite } from "../../shared/site";

/** Hidden (but laid out) until the site is known, so another site's visitors never see the default name flash by. */
export function Brand() {
  const site = useSite();
  return <div className="brand" style={site ? undefined : { visibility: "hidden" }} aria-hidden={site ? undefined : true}><span className="brand-mark"><BrandMark size={34} logoSvg={site?.logoSvg} /></span><span><BrandWordmark name={site?.name} /></span></div>;
}
