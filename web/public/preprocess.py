import ast, re, textwrap, json

class Rejected(ValueError):
    pass


def strip_docstrings(code):
    code = textwrap.dedent(code).strip()
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError, RecursionError) as e:
        raise Rejected("syntax") from e
    if len(tree.body) != 1 or not isinstance(tree.body[0], (ast.FunctionDef, ast.AsyncFunctionDef)):
        raise Rejected("not_single_function")
    # AST columns are UTF-8 byte offsets, not Python character offsets.
    lines = code.encode("utf-8").splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    edits = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)):
            if node.body and isinstance(node.body[0], ast.Expr):
                first = node.body[0]
                if isinstance(first.value, ast.Constant) and isinstance(first.value.value, str):
                    a = offsets[first.lineno - 1] + first.col_offset
                    b = offsets[first.end_lineno - 1] + first.end_col_offset
                    # pass also handles docstring-only functions and one-line semicolons.
                    edits.append((a, b, b"pass"))
    raw = code.encode("utf-8")
    for a, b, replacement in sorted(edits, reverse=True):
        raw = raw[:a] + replacement + raw[b:]
    clean = raw.decode("utf-8")
    tree = ast.parse(clean)
    useful = [n for n in tree.body[0].body if not isinstance(n, ast.Pass)]
    if not useful or all(isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) and n.value.value is Ellipsis for n in useful):
        raise Rejected("empty_function")
    return clean


def _bound_names(function):
    names = {a.arg for a in [*function.args.posonlyargs,*function.args.args,*function.args.kwonlyargs]}
    if function.args.vararg:
        names.add(function.args.vararg.arg)
    if function.args.kwarg:
        names.add(function.args.kwarg.arg)
    class Bindings(ast.NodeVisitor):
        def visit_Name(self,node):
            if isinstance(node.ctx,(ast.Store,ast.Del)):
                names.add(node.id)
        def visit_FunctionDef(self,node): names.add(node.name)
        visit_AsyncFunctionDef = visit_FunctionDef
        def visit_ClassDef(self,node): names.add(node.name)
        def visit_Lambda(self,node): pass
        def visit_Import(self,node):
            names.update(a.asname or a.name.split('.')[0] for a in node.names)
        visit_ImportFrom = visit_Import
    visitor = Bindings()
    for node in function.body:
        visitor.visit(node)
    return names


def _rename_tree(tree,new_name,positions=None):
    root = tree.body[0]
    old = root.name
    root.name = new_name
    scopes = [_bound_names(root)]
    class Canonical(ast.NodeTransformer):
        def visit_Name(self,node):
            if node.id == old and not any(old in scope for scope in scopes):
                if positions is not None:positions.append((node.lineno,node.col_offset,node.end_lineno,node.end_col_offset))
                node.id = new_name
            return node
        def visit_FunctionDef(self,node):
            scopes.append(_bound_names(node))
            node = self.generic_visit(node)
            scopes.pop()
            return node
        visit_AsyncFunctionDef = visit_FunctionDef
    visitor = Canonical()
    root.body = [visitor.visit(n) for n in root.body if not isinstance(n,ast.Pass)]
    ast.fix_missing_locations(tree)
    return tree


def canonical_code(code):
    tree = _rename_tree(ast.parse(strip_docstrings(code)),"_function")
    return ast.unparse(tree)


def normalize_bindings(code):
    tree=ast.parse(canonical_code(code))
    if len(tree.body)!=1 or not isinstance(tree.body[0],ast.FunctionDef):
        raise ValueError('Expected one Python function')
    root=tree.body[0]
    parameters=[*root.args.posonlyargs,*root.args.args,*root.args.kwonlyargs]
    if root.args.vararg:parameters.append(root.args.vararg)
    if root.args.kwarg:parameters.append(root.args.kwarg)
    bound={a.arg for a in parameters}|{n.id for n in ast.walk(root) if isinstance(n,ast.Name) and isinstance(n.ctx,ast.Store)}
    bound|={n.name for n in ast.walk(root) if isinstance(n,ast.FunctionDef)}
    free={n.id for n in ast.walk(root) if isinstance(n,ast.Name) and isinstance(n.ctx,ast.Load)}-bound
    prefix=''
    while any(re.fullmatch(re.escape(prefix)+r'(?:arg|local)\d+',name) for name in free):prefix+='_' 
    mapping={a.arg:f'{prefix}arg{i}' for i,a in enumerate(parameters)}
    local=0
    for node in ast.walk(root):
        if isinstance(node,ast.Name) and isinstance(node.ctx,ast.Store) and node.id not in mapping:
            mapping[node.id]=f'{prefix}local{local}';local+=1
        elif isinstance(node,ast.FunctionDef) and node is not root and node.name not in mapping:
            mapping[node.name]=f'{prefix}local{local}';local+=1
    # One simultaneous bijection preserves lexical shadowing and comprehensions.
    for node in ast.walk(root):
        if isinstance(node,ast.Name):node.id=mapping.get(node.id,node.id)
        elif isinstance(node,ast.arg):node.arg=mapping.get(node.arg,node.arg)
        elif isinstance(node,ast.FunctionDef) and node is not root:node.name=mapping.get(node.name,node.name)
        elif isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id==root.name:
            for keyword in node.keywords:keyword.arg=mapping.get(keyword.arg,keyword.arg)
    ast.fix_missing_locations(tree)
    return ast.unparse(tree),mapping


def restore_names(text,mapping):
    """Restore identifier words outside string literals, including incomplete streams."""
    reverse={v:k for k,v in mapping.items()}
    pattern=re.compile(r'\b(?:'+'|'.join(re.escape(name) for name in reverse)+r')\b') if reverse else None
    parts=[];index=0;start=0;quote=None;escaped=False
    def replace(chunk):
        return pattern.sub(lambda m:reverse[m.group()],chunk) if pattern else chunk
    while index<len(text):
        char=text[index]
        if quote is None and char in ['"',"'"]:
            parts.append(replace(text[start:index]));start=index;quote=char;escaped=False
        elif quote is not None:
            if escaped:escaped=False
            elif char=='\\':escaped=True
            elif char==quote:
                parts.append(text[start:index+1]);start=index+1;quote=None
        index+=1
    parts.append(text[start:] if quote else replace(text[start:]))
    return ''.join(parts)


def reasoning_prompt(code, inputs=None):
    instruction = ('Explain all branches and track variable dependencies. Write Steps:, '
                   'Result expression: with equivalent Python, then Summary: with the behavior.')
    if inputs is not None:
        instruction = ('Execute for these arguments: ' + json.dumps(inputs, sort_keys=True) +
                       '. Write Trace: with executed lines and values, then Return: with its Python value.')
    return 'Python function:\n' + canonical_code(code) + '\n\n' + instruction + '\nAnswer:\n'


"""Optional name normalization; arbitrary input is never rejected as non-Python."""


SNIPPET_ENABLED = True
SNIPPET_INSTRUCTION = 'Explain this Python code step by step. Write Steps:, Result expression: for printed values or the final value, then Summary: with what the code does.'

def normalize_snippet(code):
    tree = ast.parse(code)
    if not tree.body:
        raise ValueError('Empty code')
    bound = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store)}
    free = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)} - bound
    prefix = ''
    while any(re.fullmatch(re.escape(prefix)+r'local\d+', n) for n in free):
        prefix += '_'
    mapping = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) and node.id not in mapping:
            mapping[node.id] = f'{prefix}local{len(mapping)}'
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            node.id = mapping.get(node.id, node.id)
    return ast.unparse(ast.fix_missing_locations(tree)), mapping

def snippet_prompt(code):
    return 'Python code:\n'+code+'\n\n'+SNIPPET_INSTRUCTION+'\nAnswer:\n'

"""Optional name normalization; arbitrary input is never rejected as non-Python."""


def prepare(code):
    try:
        source, mapping = normalize_bindings(code)
        prompt = reasoning_prompt(source)
        mode = 'normalized_python'
    except (SyntaxError, ValueError, RecursionError):
        if globals().get('SNIPPET_ENABLED', False):
            try:
                source, mapping = normalize_snippet(code)
                prompt, mode = snippet_prompt(source), 'snippet'
            except (SyntaxError, ValueError, RecursionError):
                source, mapping, prompt, mode = code, {}, code, 'raw_text'
        else:
            # Pass non-code, partial code and other text directly to the tokenizer.
            source, mapping, prompt, mode = code, {}, code, 'raw_text'
    return json.dumps({'prompt': prompt, 'mapping': mapping,
                       'canonical': source, 'input_mode': mode})
