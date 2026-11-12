import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function ComponentSettingsDialog({ title, onClose, children, surfaceLabel = 'Creatio', className = '' }: { title: string; onClose: () => void; children: ReactNode; surfaceLabel?: string; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <dialog ref={dialog} className={`creatio-settings-dialog${className ? ` ${className}` : ''}`} aria-label={`Component Settings: ${title}`} data-testid="creatio-settings-dialog"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><div><small>{surfaceLabel}</small><h2>Component Settings</h2></div><button type="button" aria-label="Close component settings" onClick={onClose}><X size={20} /></button></header>
    <div className="creatio-settings-dialog-content">{children}</div>
  </dialog>;
}
