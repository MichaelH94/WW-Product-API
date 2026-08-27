import {useEffect, useState} from 'preact/hooks';
import {useLocation} from 'preact-iso';

import {searchProducts} from '../../../../shared/shopify/products.ts';

export default function ProductDiagnosticsPage({enabled = false}) {
  const {route} = useLocation();
  const [state, setState] = useState({loading: true, products: [], error: null});

  useEffect(() => {
    if (!enabled) return;

    let active = true;
    searchProducts({first: 10, includeInventoryLevels: true})
      .then(({products}) => {
        if (active) setState({loading: false, products, error: null});
      })
      .catch((error) => {
        if (active) {
          setState({
            loading: false,
            products: [],
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      });

    return () => {
      active = false;
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <s-page heading="Development product diagnostics">
      <s-button slot="secondary-actions" onClick={() => route('/')}>Back</s-button>
      <s-section heading="Internal diagnostic only">
        <s-paragraph>
          This authenticated read-only view is enabled only in development
          builds on a confirmed partner development store. It displays up to 10
          products from the connected store.
        </s-paragraph>
      </s-section>

      {state.loading && (
        <s-section>
          <s-paragraph>Loading products…</s-paragraph>
        </s-section>
      )}

      {state.error && (
        <s-section heading="Shopify query failed">
          <s-paragraph>{state.error}</s-paragraph>
        </s-section>
      )}

      {state.products.map((product) => (
        <s-section key={product.id} heading={product.title}>
          {product.variants.map((variant) => (
            <s-grid key={variant.id} gap="small-200" paddingBlock="small-200">
              <s-paragraph>
                Variant: {variant.title} | SKU: {variant.sku || '—'} | Barcode:{' '}
                {variant.barcode || '—'}
              </s-paragraph>
              {!variant.inventoryItem?.tracked && (
                <s-paragraph>Inventory is not tracked for this variant.</s-paragraph>
              )}
              {variant.inventoryItem?.tracked &&
                variant.inventoryItem.levels.length === 0 && (
                  <s-paragraph>No inventory levels returned.</s-paragraph>
                )}
              {variant.inventoryItem?.levels.map((level) => (
                <s-paragraph key={level.id}>
                  {level.location.name}:{' '}
                  {level.quantities.map(({name, quantity}) =>
                    `${name} ${quantity}`).join(', ')}
                </s-paragraph>
              ))}
            </s-grid>
          ))}
        </s-section>
      ))}
    </s-page>
  );
}
