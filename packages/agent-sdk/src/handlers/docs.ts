const CUSTOM_CSS = `
/* AgentStep Gateway Design System — Scalar Theme */
.light-mode {
  --scalar-color-1: #171717;
  --scalar-color-2: #525252;
  --scalar-color-3: #737373;
  --scalar-color-accent: #65a30d;
  --scalar-color-green: #65a30d;
  --scalar-background-1: #ffffff;
  --scalar-background-2: #f5f5f5;
  --scalar-background-3: #e5e5e5;
  --scalar-background-accent: #ecfccb;
  --scalar-border-color: #e5e5e5;
  --scalar-sidebar-background-1: #f5f5f5;
  --scalar-sidebar-color-1: #171717;
  --scalar-sidebar-color-2: #525252;
  --scalar-sidebar-color-active: #65a30d;
  --scalar-sidebar-border-color: #e5e5e5;
  --scalar-button-1: #171717;
  --scalar-button-1-color: #ffffff;
  --scalar-button-1-hover: #262626;
}
.dark-mode {
  --scalar-color-1: #e5e5e5;
  --scalar-color-2: #a3a3a3;
  --scalar-color-3: #737373;
  --scalar-color-accent: #a3e635;
  --scalar-color-green: #a3e635;
  --scalar-background-1: #0a0a0a;
  --scalar-background-2: #171717;
  --scalar-background-3: #262626;
  --scalar-background-accent: rgba(163,230,53,0.1);
  --scalar-border-color: rgba(255,255,255,0.1);
  --scalar-sidebar-background-1: #171717;
  --scalar-sidebar-color-1: #e5e5e5;
  --scalar-sidebar-color-2: #a3a3a3;
  --scalar-sidebar-color-active: #a3e635;
  --scalar-sidebar-border-color: rgba(255,255,255,0.1);
  --scalar-button-1: #a3e635;
  --scalar-button-1-color: #0a0a0a;
  --scalar-button-1-hover: #bef264;
}
`.trim();

const SCALAR_CONFIG_JSON = JSON.stringify({
  spec: { url: "/v1/openapi.json" },
  theme: "none",
  layout: "modern",
  documentDownloadType: "direct",
  darkMode: true,
  customCss: CUSTOM_CSS,
  hiddenClients: true,
  hideGenerateMcpServer: true,
  metaData: {
    title: "AgentStep Gateway — API Reference",
  },
}).replace(/"/g, "&quot;");

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentStep Gateway — API Reference</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      body { margin: 0; }
    </style>
  </head>
  <body>
    <script
      id="api-reference"
      data-configuration="${SCALAR_CONFIG_JSON}"
    ></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>
`;

export async function handleGetDocs(): Promise<Response> {
  return new Response(HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    },
  });
}
