export function EditorActionButton({ icon: Icon, children, ...props }) {
  return <button type="button" className="ghost-button" {...props}><Icon size={15} aria-hidden="true" /><span>{children}</span></button>;
}
