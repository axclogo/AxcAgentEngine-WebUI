import type { AttachmentAdapter, CompleteAttachment } from '@assistant-ui/react';
import type { Attachment } from './core';
export function attachmentBridge(
  upload: (file: File, signal: AbortSignal) => Promise<Attachment>,
  onError: (message: string) => void,
  allowed: () => boolean = () => true,
) {
  const uploaded = new Map<string, Attachment>();
  const adapter: AttachmentAdapter = {
    accept: '*',
    add: async ({ file }) => {
      if (!allowed()) throw new Error('当前会话不支持附件');
      return {
        id: crypto.randomUUID(),
        type: 'file',
        name: file.name,
        file,
        contentType: file.type,
        status: { type: 'requires-action', reason: 'composer-send' },
      };
    },
    remove: async () => {},
    send: async (attachment, options) => {
      try {
        const result = await upload(attachment.file, options?.signal ?? new AbortController().signal);
        uploaded.set(attachment.id, result);
        return {
          ...attachment,
          status: { type: 'complete' },
          content: [{ type: 'file', data: result.url, mimeType: result.contentType, filename: result.name }],
        };
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
  };
  return {
    adapter,
    resolve: (attachments: readonly CompleteAttachment[]) => attachments.map((a) => uploaded.get(a.id)!),
  };
}
