import {executeAdminGraphql} from "./admin-direct.ts";
import {isPartnerDevelopmentStore as checkPartnerDevelopmentStore} from "./shop.ts";

export function isPartnerDevelopmentStore(): Promise<boolean> {
  return checkPartnerDevelopmentStore(executeAdminGraphql);
}
