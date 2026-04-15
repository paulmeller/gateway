export function DocsPage() {
  return (
    <div className="h-full">
      <iframe
        src="/v1/docs"
        className="w-full h-full border-0"
        title="API Documentation"
      />
    </div>
  );
}
