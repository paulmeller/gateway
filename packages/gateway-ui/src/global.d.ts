interface Window {
  __MA_API_KEY__?: string;
  __MA_VERSION__?: string;
}

declare module "*.css" {
  const _: string;
  export default _;
}
