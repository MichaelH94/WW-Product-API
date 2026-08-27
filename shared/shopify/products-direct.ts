import {executeAdminGraphql} from "./admin-direct.ts";
import {createProductDataAccess} from "./products.ts";

const productDataAccess = createProductDataAccess(executeAdminGraphql);

export const searchProducts = productDataAccess.searchProducts;
export const getProductById = productDataAccess.getProductById;
export const getProductBySku = productDataAccess.getProductBySku;
export const getProductByBarcode = productDataAccess.getProductByBarcode;
export const getInventoryForVariant = productDataAccess.getInventoryForVariant;
