import { getSiteActions } from "../site-actions.js";

export function getBridgeActions() {
  return getSiteActions().filter((action) => action.availability === "bridge");
}
