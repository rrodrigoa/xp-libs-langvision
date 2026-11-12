import * as monaco from 'monaco-editor/editor/editor.api.js';

export const WORKSPACE_EDITOR_THEME='chronoscope-chronosql';
let configured=false;
export function ensureWorkspaceEditorTheme() {
  if(configured)return;configured=true;
  monaco.editor.defineTheme(WORKSPACE_EDITOR_THEME,{
    base:'vs-dark',inherit:true,
    rules:[{token:'keyword',foreground:'60A5FA',fontStyle:'bold'},{token:'comment',foreground:'65A30D'},{token:'string',foreground:'F59E0B'},{token:'number',foreground:'FBBF24'},{token:'identifier',foreground:'E5E7EB'}],
    colors:{'editor.background':'#1e1e1e','editor.foreground':'#cccccc','editor.lineHighlightBackground':'#2a2d2e','editorCursor.foreground':'#569cd6','editor.selectionBackground':'#264f78','editor.inactiveSelectionBackground':'#3a3d41','editorGutter.background':'#1e1e1e'}
  });
}
