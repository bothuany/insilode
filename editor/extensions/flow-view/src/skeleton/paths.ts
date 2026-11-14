/*---------------------------------------------------------------------------------------------
 *  Insilode skeleton first: where each planned new type goes. Derived from the layout the project already has, never invented: the module
 *  the plan's existing types live in, the package its siblings of the same kind (controller, service, impl, dto, client) sit in, and
 *  the way that module spells its folders. The developer writes the members; this only says which file to put the type in.
 *  Pure: no vscode, no fs.
 *--------------------------------------------------------------------------------------------*/

import type { BoardNode, BoardSpec } from '../../../../../board-canvas/spec';
import type { TypeInfo } from '../types/model';

export interface Target {
	/** Absolute path of the file the type belongs in. */
	file: string;
	module: string;
	/** Java package, C# namespace, Python module or folder: the grouping the type belongs in. */
	packageName: string;
	/** How it was found: next to its siblings of the same kind (`siblings`), or from the module's naming (`convention`): only the first can call a package wrong. */
	basis: 'siblings' | 'convention';
	/** One line for the developer and the agent: what the path follows. */
	reason: string;
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const slash = (p: string) => p.replace(/\\/g, '/');
const dirOf = (file: string) => slash(file).replace(/\/[^/]*$/, '');
const baseOf = (file: string) => slash(file).split('/').pop()!;
const extOf = (file: string) => /\.[A-Za-z0-9]+$/.exec(baseOf(file))?.[0] ?? '';

/** The word a type is named for: `BillServiceImpl` → impl, `CustomerClient` → client, `BillDTO` → dto. */
const FAMILIES: [string, RegExp][] = [
	['impl', /Impl$/],
	['controller', /Controller$/], ['service', /Service$/], ['repository', /Repository$/], ['client', /Client$/], ['config', /Config(uration)?$/],
	['dto', /(Dto|DTO|Request|Response)$/], ['mapper', /Mapper$/], ['event', /Event$/], ['exception', /Exception$/], ['entity', /Entity$/],
	['handler', /Handler$/], ['listener', /Listener$/], ['producer', /Producer$/], ['consumer', /Consumer$/], ['enum', /(Status|Type|Kind)$/],
];
export function familyOf(name: string): string | undefined {
	return FAMILIES.find(([, re]) => re.test(name))?.[0];
}

/** What the plan says the type is, when its name does not (`kind` of the node), as the family folder it usually lives in. */
const KIND_FAMILY: Record<string, string> = { controller: 'controller', service: 'service', repository: 'repository', dto: 'dto', entity: 'entity', enum: 'enum' };

const most = <T>(items: T[], by: (t: T) => string): T[] => {
	const count = new Map<string, number>();
	items.forEach(i => count.set(by(i), (count.get(by(i)) ?? 0) + 1));
	const top = Math.max(0, ...count.values());
	return items.filter(i => count.get(by(i)) === top);
};

const segments = (pkg: string) => pkg.split('.').filter(Boolean);

/** The longest package that all of them start with: the module's own base package. */
function basePackage(packages: string[]): string {
	const lists = packages.filter(Boolean).map(segments);
	if (!lists.length) {
		return '';
	}
	let n = Math.min(...lists.map(l => l.length));
	let prefix = lists[0].slice(0, n);
	for (const l of lists) {
		while (prefix.some((s, i) => l[i] !== s)) {
			prefix = prefix.slice(0, --n);
		}
	}
	return prefix.join('.');
}

/** Whether the folders of a module are plural (`controllers`, `services`) or singular (`controller`, `service`). */
function plural(types: TypeInfo[]): boolean {
	const last = types.map(t => segments(t.packageName).pop() ?? '');
	const plurals = last.filter(s => /^(controllers|services|repositories|dtos|entities|models|clients|configs|handlers|mappers|events)$/.test(s)).length;
	const singulars = last.filter(s => /^(controller|service|repository|dto|entity|model|client|config|handler|mapper|event)$/.test(s)).length;
	return plurals > singulars;
}

const PLURAL: Record<string, string> = { controller: 'controllers', service: 'services', repository: 'repositories', dto: 'dtos', entity: 'entities', client: 'clients', config: 'configs', handler: 'handlers', mapper: 'mappers', event: 'events', exception: 'exceptions', enum: 'enums' };

/** The folder of a package inside a module: the sibling's folder with its own package path swapped for the target's. */
function directoryFor(sibling: TypeInfo, packageName: string): string {
	const dir = dirOf(sibling.file);
	const own = slash(sibling.packageName.replace(/\./g, '/'));
	if (sibling.packageName && own && dir.toLowerCase().endsWith('/' + own.toLowerCase())) {
		return dir.slice(0, dir.length - own.length) + slash(packageName.replace(/\./g, '/'));
	}
	return dir;
}

/** `Foo` in the style the siblings' files are named: `FooBar.java`, `foo-bar.ts`, `foo_bar.py`. */
function fileNameFor(name: string, sibling: TypeInfo): string {
	const ext = extOf(sibling.file);
	const stem = baseOf(sibling.file).slice(0, baseOf(sibling.file).length - ext.length);
	if (/[A-Z]/.test(stem) || sibling.lang === 'java' || sibling.lang === 'csharp') {
		return name + ext;
	}
	const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' ');
	return words.join(stem.includes('_') ? '_' : '-') + ext;
}

/** A label that may become a file name and a declaration: an identifier, and not a Windows device name (CON.java is the console there). */
export const isTypeName = (label: string) => /^[A-Za-z_$][\w$]*$/.test(label) && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(label);

export interface PathContext {
	/** Types that count as the layout of the project: the code as it was when the design was drawn (the developer's new types are not the convention). */
	existing: (t: TypeInfo) => boolean;
	/** A module to prefer when the plan names none (the one the developer has open). */
	hintModule?: string;
}

/** The module the plan is about: where its types that already exist live, else the module its title names, else the hint, else the only one. */
export function moduleOfPlan(plan: BoardSpec, types: TypeInfo[], ctx: PathContext): string | undefined {
	const names = new Set(plan.nodes.map(n => key(n.label)));
	const modules = [...new Set(types.map(t => t.module))];
	const known = types.filter(t => ctx.existing(t) && names.has(key(t.name)));
	if (known.length) {
		const top = most(known, t => t.module).map(t => t.module);
		if (top.length === 1) {
			return top[0];
		}
		// Tied (a shared client in three services): the module the title names, or the hint, among the tied ones.
		const titled = top.find(m => key(plan.title).includes(key(m)));
		return titled ?? (ctx.hintModule && top.includes(ctx.hintModule) ? ctx.hintModule : top.sort()[0]);
	}
	// Anything the agent wrote on the board names the module it is about: the title, the description, a group, a node's line or note.
	const said = key([plan.title, plan.description, ...(plan.groups ?? []).map(g => g.label), ...plan.nodes.flatMap(n => [n.detail, n.note, n.group])].filter(Boolean).join(' '));
	const titled = modules.find(m => said.includes(key(m)));
	return titled ?? (ctx.hintModule && modules.includes(ctx.hintModule) ? ctx.hintModule : modules.length === 1 ? modules[0] : undefined);
}

/**
 * Where a new type goes, or undefined when the project gives no layout to follow (no types at all, or several modules and nothing in the
 * plan says which). `interfaceOf` is the planned interface a class implements: an `Impl` goes in that interface's `impl` folder.
 */
export function targetFor(node: BoardNode, plan: BoardSpec, types: TypeInfo[], ctx: PathContext, module = moduleOfPlan(plan, types, ctx)): Target | undefined {
	// The label becomes a file name and a declaration: only an identifier is one (an agent's label is not trusted to be).
	if (!module || !isTypeName(node.label)) {
		return undefined;
	}
	const inModule = types.filter(t => t.module === module && ctx.existing(t) && key(t.name) !== key(node.label));
	if (!inModule.length) {
		return undefined;
	}
	const family = familyOf(node.label) ?? (node.kind ? KIND_FAMILY[node.kind] : undefined);
	let siblings = family ? inModule.filter(t => familyOf(t.name) === family) : [];
	if (!siblings.length && node.kind && node.kind !== 'class' && node.kind !== 'interface') {
		const role = node.kind === 'entity' ? 'entity' : node.kind === 'controller' ? 'controller' : node.kind;
		siblings = inModule.filter(t => t.role === role || (role === 'controller' && t.role === 'handler'));
	}
	if (siblings.length) {
		const top = most(siblings, t => t.packageName)[0];
		const sibling = siblings.find(t => t.packageName === top.packageName)!;
		return {
			file: `${directoryFor(sibling, sibling.packageName)}/${fileNameFor(node.label, sibling)}`, module, packageName: sibling.packageName, basis: 'siblings',
			reason: `next to ${siblings.length === 1 ? sibling.name : `${sibling.name} and the other ${family ?? node.kind}s`}, in ${sibling.packageName || 'its folder'}`,
		};
	}
	// No sibling of this kind: the module's base package and its own way of spelling folders.
	const any = most(inModule, t => t.packageName)[0];
	const base = basePackage(inModule.map(t => t.packageName));
	const ownFamily = family ?? 'class';
	const folder = family && family !== 'impl' ? (plural(inModule) ? PLURAL[family] ?? family : family) : '';
	// An implementation goes under its interface, in `impl`, unless the project has none of those (then it sits beside it).
	const iface = family === 'impl' ? plan.edges.filter(e => e.from === node.id && e.kind === 'implements').map(e => plan.nodes.find(n => n.id === e.to)).find(Boolean) : undefined;
	const ifaceType = iface ? types.find(t => t.module === module && key(t.name) === key(iface.label)) : undefined;
	const ifaceTarget = iface && !ifaceType ? targetFor(iface, plan, types, ctx, module) : undefined;
	const parent = ifaceType?.packageName ?? ifaceTarget?.packageName;
	const packageName = family === 'impl' ? [parent ?? base, 'impl'].filter(Boolean).join('.') : [base, folder].filter(Boolean).join('.');
	const file = `${directoryFor(any, packageName)}/${fileNameFor(node.label, any)}`;
	return {
		file, module, packageName, basis: 'convention',
		reason: `no ${ownFamily} in ${module} yet: the base package ${base || '(none)'}${folder ? ` and a ${folder} folder, spelled as the module spells them` : ''}`,
	};
}

/** The empty file for a type: the package line and the declaration, nothing else. The developer writes the members. */
export function stubFor(node: BoardNode, packageName: string, file: string): string | undefined {
	const name = node.label;
	if (!isTypeName(name)) {
		return undefined;
	}
	const ext = extOf(file).toLowerCase();
	const kind = node.kind;
	if (ext === '.java') {
		const word = kind === 'interface' ? 'interface' : kind === 'enum' ? 'enum' : 'class';
		return `${packageName ? `package ${packageName};\n\n` : ''}public ${word} ${name} {\n}\n`;
	}
	if (ext === '.cs') {
		const word = kind === 'interface' ? 'interface' : kind === 'enum' ? 'enum' : 'class';
		return `${packageName ? `namespace ${packageName};\n\n` : ''}public ${word} ${name}\n{\n}\n`;
	}
	if (ext === '.ts' || ext === '.tsx') {
		return `export ${kind === 'interface' ? 'interface' : kind === 'enum' ? 'enum' : 'class'} ${name} {\n}\n`;
	}
	if (ext === '.py') {
		return `class ${name}:\n    pass\n`;
	}
	return undefined;
}
