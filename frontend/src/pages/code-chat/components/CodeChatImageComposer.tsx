import { X } from "lucide-react";
import { Image } from "antd";
import { useI18n } from "@/i18n/I18nContext";
import type { CodeChatImagePayload } from "./types";

type Props = {
  images: CodeChatImagePayload[];
  disabled?: boolean;
  onRemove: (id: string) => void;
};

export function CodeChatImageComposer({ images, disabled = false, onRemove }: Props) {
  const { t } = useI18n();

  if (images.length === 0) return null;

  return (
    <Image.PreviewGroup>
      <div className="flex flex-wrap gap-2">
        {images.map((image) => (
          <div
            key={image.id}
            className="group relative h-20 w-20 overflow-hidden rounded-xl border border-border/60 bg-muted/40"
          >
            <Image
              src={image.dataUrl}
              alt={image.name}
              width={80}
              height={80}
              className="object-cover"
              style={{ objectFit: "cover" }}
              preview={{ mask: false }}
            />
            <button
              type="button"
              className="absolute right-1 top-1 z-10 inline-flex size-6 items-center justify-center rounded-full bg-background/90 text-foreground shadow transition hover:bg-background"
              aria-label={t("chat.removeImageAria")}
              onClick={() => onRemove(image.id)}
              disabled={disabled}
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </Image.PreviewGroup>
  );
}
