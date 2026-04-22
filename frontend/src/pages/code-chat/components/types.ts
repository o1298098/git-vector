export type CodeChatProjectOption = { project_id: string; project_name?: string | null };

export type CodeChatImagePayload = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size: number;
};
