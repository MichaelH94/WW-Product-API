import {render} from 'preact';
import {LocationProvider, ErrorBoundary, Router, Route} from 'preact-iso';

import HomePage from './pages/HomePage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import {DEVELOPMENT_BUILD} from './development.js';

export default async () => {
  let ProductDiagnosticsPage = null;
  if (DEVELOPMENT_BUILD) {
    try {
      const [pageModule, shopModule] = await Promise.all([
        import('./pages/ProductDiagnosticsPage.jsx'),
        import('../../../shared/shopify/shop.ts'),
      ]);
      if (await shopModule.isPartnerDevelopmentStore()) {
        ProductDiagnosticsPage = pageModule.default;
      }
    } catch {
      ProductDiagnosticsPage = null;
    }
  }

  render(<App ProductDiagnosticsPage={ProductDiagnosticsPage} />, document.body);
};

function App({ProductDiagnosticsPage}) {
  return (
    <LocationProvider>
      <ErrorBoundary>
        <Router>
          <Route
            path="/"
            component={() => (
              <HomePage diagnosticsEnabled={Boolean(ProductDiagnosticsPage)} />
            )}
          />
          {ProductDiagnosticsPage && (
            <Route
              path="/__dev/product-diagnostics"
              component={() => <ProductDiagnosticsPage enabled />}
            />
          )}
          <Route default component={NotFoundPage} />
        </Router>
      </ErrorBoundary>
    </LocationProvider>
  );
}
