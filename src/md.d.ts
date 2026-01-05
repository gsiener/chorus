// Type declaration for .md file imports (bundled as text by wrangler)
declare module "*.md" {
  const content: string;
  export default content;
}
