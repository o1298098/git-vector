import type { CSSProperties } from "react";
import type { BubbleListProps } from "@ant-design/x";
import { Spin } from "antd";

/** 助手：文档式排版，无卡片底（对齐 ChatGPT 宽屏阅读体验） */
const AI_ASSISTANT_DOCUMENT_BODY: CSSProperties = {
  maxWidth: "100%",
  borderRadius: 0,
  background: "transparent",
  border: "none",
  boxShadow: "none",
  paddingInline: 2,
  paddingBlock: 6,
  boxSizing: "border-box",
};

const AI_LOADING_ROW: CSSProperties = {
  ...AI_ASSISTANT_DOCUMENT_BODY,
  display: "flex",
  alignItems: "center",
  minHeight: 36,
};

/**
 * 用户：右侧圆角块；助手：通栏正文，无气泡框。
 */
export const CODE_CHAT_BUBBLE_ROLE: NonNullable<BubbleListProps["role"]> = {
  user: {
    placement: "end",
    variant: "borderless",
    shape: "corner",
    styles: {
      body: {
        maxWidth: "min(100%, 75%)",
        borderRadius: "1.35rem",
        background: "hsl(var(--muted) / 0.5)",
        border: "1px solid hsl(var(--border) / 0.28)",
        boxShadow: "none",
        paddingInline: 16,
        paddingBlock: 10,
        boxSizing: "border-box",
      },
      content: {
        maxWidth: "100%",
        fontSize: 16,
        lineHeight: 1.55,
        color: "hsl(var(--foreground))",
      },
    },
  },
  ai: (item) => ({
    placement: "start",
    variant: "borderless",
    shape: "corner",
    styles: {
      body: AI_ASSISTANT_DOCUMENT_BODY,
      content: {
        maxWidth: "100%",
        fontSize: 16,
        lineHeight: 1.75,
        color: "hsl(var(--foreground))",
      },
    },
    ...(item.loading
      ? {
          loadingRender: () => (
            <div style={AI_LOADING_ROW}>
              <Spin size="small" />
            </div>
          ),
        }
      : {}),
  }),
};
