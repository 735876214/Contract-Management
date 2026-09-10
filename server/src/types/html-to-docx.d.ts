/** html-to-docx 无官方类型声明，此处补充最小声明 */
declare module 'html-to-docx' {
  const HTMLtoDOCX: (
    html: string,
    headerHTML?: string | null,
    options?: Record<string, any>,
    footerHTML?: string | null,
  ) => Promise<Buffer | Blob | Uint8Array>;
  export default HTMLtoDOCX;
}
