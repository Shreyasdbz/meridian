import { useEffect, useRef } from 'react';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}

export function Dialog({ open, onClose, title, children, actions }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const handleClose = (): void => {
      onClose();
    };

    dialog.addEventListener('close', handleClose);
    return () => {
      dialog.removeEventListener('close', handleClose);
    };
  }, [onClose]);

  // Close on backdrop click
  const handleBackdropClick = (e: React.MouseEvent<HTMLDialogElement>): void => {
    if (e.target === dialogRef.current) {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClick={handleBackdropClick}
      className="m-auto max-w-lg rounded-xl border border-gray-200 bg-white p-0 shadow-xl backdrop:bg-black/50 dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
        <div className="mt-3 text-sm text-gray-600 dark:text-gray-300">{children}</div>
        {actions && <div className="mt-6 flex justify-end gap-3">{actions}</div>}
      </div>
    </dialog>
  );
}
