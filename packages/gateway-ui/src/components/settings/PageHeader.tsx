import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

interface Props {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function PageHeader({ title, description, actionLabel, onAction }: Props) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {actionLabel && onAction && (
        <Button variant="secondary" size="sm" onClick={onAction} className="gap-1.5">
          <Plus className="size-3.5" />
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
