import { ReactFlow, Background, Controls } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

export function CompositionFlow({ children, ...props }) {
  return <ReactFlow colorMode="dark" {...props}>{children ?? <><Background gap={24} size={1} /><Controls showInteractive={false} /></>}</ReactFlow>;
}
