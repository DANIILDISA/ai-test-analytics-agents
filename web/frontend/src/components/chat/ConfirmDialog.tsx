// web/frontend/src/components/chat/ConfirmDialog.tsx
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ConfirmEvent } from "@/types/chat";

export interface ConfirmDialogProps {
  request: ConfirmEvent;
  onResolve: (approve: boolean) => void;
}

export function ConfirmDialog({ request, onResolve }: ConfirmDialogProps) {
  const isRunAnalysis = request.name === "run_analysis";
  const title = isRunAnalysis
    ? "Запустить анализ по приложенным файлам?"
    : `Подтвердить действие «${request.name}»?`;
  const body = isRunAnalysis
    ? "Будет запущен новый анализ (C1) по приложенным файлам. Модель — из Настроек. Параметры:"
    : "Агент предлагает выполнить действие с параметрами:";
  return (
    <Card className="border-korpus-blue">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-2 text-sm text-muted-foreground">{body}</p>
        <pre className="mb-3 overflow-x-auto rounded-korpus bg-muted p-2 text-xs">
          {JSON.stringify(request.arguments, null, 2)}
        </pre>
        <div className="flex gap-2">
          <Button type="button" onClick={() => onResolve(true)}>
            Подтвердить
          </Button>
          <Button type="button" variant="outline" onClick={() => onResolve(false)}>
            Отмена
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
