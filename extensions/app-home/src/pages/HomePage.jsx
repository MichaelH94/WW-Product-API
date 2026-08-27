import {useLocation} from 'preact-iso';

export default function HomePage({diagnosticsEnabled = false}) {
  const {route} = useLocation();

  return (
    <s-page heading="test-run">
      {diagnosticsEnabled && (
        <s-section heading="Development tools">
          <s-button onClick={() => route('/__dev/product-diagnostics')}>
            Open product diagnostics
          </s-button>
        </s-section>
      )}
    </s-page>
  );
}
