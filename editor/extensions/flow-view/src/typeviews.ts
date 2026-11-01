/*---------------------------------------------------------------------------------------------
 *  Insilode type views: the commands that open the DTO relation diagram and the architecture diagram on the board
 *  canvas, drawn from the type graph (src/types). The canvas asks this file to draw again (focus a type, search,
 *  hide roles) through a BoardSource, so the graph work stays in the host.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { BoardPanel, type BoardSource } from './boardPanel';
import { archOptions, ARCHITECTURE_DEFAULTS, dropKinds, dtoOptions, fileTypeName, sanitizeRequest, type BoardRequest } from './boardRequest';
import type { BoardSpec } from './board/spec';
import { withCutNote } from './types/boards';
import { TypeService } from './types/typeService';

export const TypeCommand = {
	showDtoDiagram: 'flow.types.showDtoDiagram',
	showArchitecture: 'flow.types.showArchitecture',
	exportMermaid: 'flow.types.exportMermaid',
	focusType: 'flow.types.focusType',
} as const;

const DTO_KEY = 'types.dto';
const ARCH_KEY = 'types.architecture';

/** What `registerTypeViews` needs from the extension's shared state (extension.ts's Flow has these). */
export interface TypeViewsHost {
	context: vscode.ExtensionContext;
	log?: vscode.LogOutputChannel;
}

const config = () => vscode.workspace.getConfiguration('flow.types');

/** Mermaid or PlantUML text of a type diagram; a diagram cut by `flow.types.maxNodes` starts with a comment that says so. */
const exportText = (service: () => TypeService, spec: BoardSpec, format: 'mermaid' | 'plantuml') => withCutNote(service().exportBoard(spec, format), spec, format);

/** The DTO diagram's toolbar when nothing was changed: entities as the setting says, enums on. */
const dtoDefaults = (): BoardRequest => ({ includeEntities: config().get<boolean>('includeEntities') === true, includeEnums: true });

/** The architecture toolbar when nothing was changed; `flow.types.defaultCollapseLevel` (0 modules closed, 1 modules open and roles closed, 2+ all open) is the first collapse. */
const architectureDefaults = (): BoardRequest => {
	const level = config().get<number>('defaultCollapseLevel');
	return typeof level === 'number' ? { ...ARCHITECTURE_DEFAULTS, collapseLevel: Math.max(0, Math.min(9, Math.floor(level))) } : ARCHITECTURE_DEFAULTS;
};

export function registerTypeViews({ context, log }: TypeViewsHost): BoardPanel {
	const panel = new BoardPanel(context, log);
	const service = () => TypeService.get(log);

	const dto: BoardSource = {
		kind: 'dto',
		async build(request) {
			const board = await service().board('dto', dtoOptions(request, dtoDefaults()));
			return dropKinds(board, request.hideRoles);
		},
		exportText: (spec, format) => exportText(service, spec, format),
	};
	const architecture: BoardSource = {
		kind: 'architecture',
		searchOnHost: false,
		build: request => service().board('architecture', archOptions(request)),
		exportText: (spec, format) => exportText(service, spec, format),
	};

	/** The type graph is read on first use (the C# analyzer and the code index may still be starting): say so in the status bar. */
	const draw = <T>(title: string, work: () => Promise<T>) => vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, work);

	const showDto = async (request: BoardRequest = {}) => {
		const initial = { ...dtoDefaults(), ...sanitizeRequest(request) };
		const spec = await draw('Insilode: reading types…', () => dto.build(initial));
		await panel.show(spec, { key: DTO_KEY, source: dto, request: initial, reveal: true });
	};
	const showArchitecture = async (request: BoardRequest = {}) => {
		const initial = { ...architectureDefaults(), ...sanitizeRequest(request) };
		const spec = await draw('Insilode: reading types…', () => architecture.build(initial));
		await panel.show(spec, { key: ARCH_KEY, source: architecture, request: initial, reveal: true });
	};
	const fail = (e: unknown) => void vscode.window.showErrorMessage(`Insilode: ${(e as Error)?.message ?? e}`);

	/** The word at the cursor (or the selection) of the active editor, when it is a type-like name. */
	const wordAtCursor = (): string | undefined => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			return undefined;
		}
		const sel = editor.selection;
		const range = sel.isEmpty ? editor.document.getWordRangeAtPosition(sel.active) : sel;
		const word = range && editor.document.getText(range).trim();
		return word && /^[A-Za-z_$][\w$.]*$/.test(word) ? word : undefined;
	};

	/**
	 * The type a command was asked about: an id or a name, an object with one, or a file (the explorer's and the editor's context
	 * menus pass its Uri: the word at the cursor when that file is the active editor, else the type the file is named for).
	 */
	const typeRef = async (arg: unknown): Promise<{ ref: string; file?: string } | undefined> => {
		if (typeof arg === 'string' && arg.trim()) {
			return { ref: arg.trim() };
		}
		if (arg instanceof vscode.Uri) {
			const active = vscode.window.activeTextEditor;
			const word = active?.document.uri.toString() === arg.toString() ? wordAtCursor() : undefined;
			const named = fileTypeName(arg.fsPath);
			const ref = word ?? named;
			if (ref) {
				return { ref, file: arg.scheme === 'file' ? arg.fsPath : undefined };
			}
			void vscode.window.showInformationMessage(`Insilode: "${path.basename(arg.fsPath)}" does not name a type. Put the cursor on a type name and try again.`);
			return undefined;
		}
		if (typeof arg === 'object' && arg !== null) {
			const o = arg as Record<string, unknown>;
			for (const k of ['id', 'typeId', 'name', 'label']) {
				if (typeof o[k] === 'string' && o[k]) {
					return { ref: o[k] as string };
				}
			}
		}
		const word = wordAtCursor();
		if (word) {
			return { ref: word };
		}
		const typed = await vscode.window.showInputBox({ title: 'Insilode: show a type in the diagram', prompt: 'A type name', placeHolder: 'OrderDto' });
		return typed?.trim() ? { ref: typed.trim() } : undefined;
	};

	/** Which diagram a type belongs in: DTOs, enums and entities in the DTO diagram, everything else in the architecture. */
	const focusType = async (arg?: unknown) => {
		const asked = await typeRef(arg);
		if (!asked) {
			return;
		}
		const { ref } = asked;
		const found = await draw('Insilode: reading types…', () => service().detail(ref, asked.file ?? vscode.window.activeTextEditor?.document.uri.fsPath, 1));
		if (!found) {
			void vscode.window.showInformationMessage(`Insilode: "${ref}" is not a type of this workspace.`);
			return;
		}
		if (found.role === 'dto' || found.role === 'enum' || found.role === 'entity') {
			await showDto({ focusId: found.id, depth: 1, includeEntities: found.role === 'entity' ? true : undefined });
		} else {
			await showArchitecture({ focusId: found.id, depth: 2 });
		}
	};

	/** The diagram in the active board tab, else a choice. Mermaid goes to the clipboard. */
	const copyMermaid = async () => {
		let key = panel.activeKey();
		if (!key || !key.startsWith('types.')) {
			const pick = await vscode.window.showQuickPick([{ label: 'DTO diagram', key: DTO_KEY }, { label: 'Architecture diagram', key: ARCH_KEY }], { title: 'Insilode: copy a diagram as Mermaid' });
			if (!pick) {
				return;
			}
			key = pick.key;
		}
		let spec: BoardSpec | undefined = panel.specOf(key);
		let source = panel.sourceOf(key);
		if (!spec) {
			source = key === DTO_KEY ? dto : architecture;
			spec = await draw('Insilode: reading types…', () => source!.build(key === DTO_KEY ? dtoDefaults() : architectureDefaults()));
		}
		const text = source?.exportText?.(spec, 'mermaid') ?? exportText(service, spec, 'mermaid');
		await vscode.env.clipboard.writeText(text);
		void vscode.window.showInformationMessage(`Insilode: "${spec.title}" is on the clipboard as Mermaid.`);
	};

	// An open board follows the code: when the type graph is rebuilt (an edit, the index finished) it is drawn again.
	let subscribed: vscode.Disposable | undefined;
	const follow = () => {
		subscribed ??= service().onDidChange(() => {
			void panel.refresh(DTO_KEY);
			void panel.refresh(ARCH_KEY);
		});
	};

	context.subscriptions.push(
		panel,
		vscode.commands.registerCommand(TypeCommand.showDtoDiagram, (request?: BoardRequest) => { follow(); return showDto(request).catch(fail); }),
		vscode.commands.registerCommand(TypeCommand.showArchitecture, (request?: BoardRequest) => { follow(); return showArchitecture(request).catch(fail); }),
		vscode.commands.registerCommand(TypeCommand.exportMermaid, () => copyMermaid().catch(fail)),
		vscode.commands.registerCommand(TypeCommand.focusType, (arg?: unknown) => { follow(); return focusType(arg).catch(fail); }),
		{ dispose: () => subscribed?.dispose() },
	);
	return panel;
}
