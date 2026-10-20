package devcheck

import (
	"go/ast"
	"go/token"
	"strconv"
	"strings"
)

type domainSet map[string]bool

type stateAnalyzer struct {
	positions   *token.FileSet
	name        string
	file        *ast.File
	schema      stateSchema
	adopted     domainSet
	aliases     map[string]bool
	fileAliases map[string]map[string]bool
	symbols     map[string][]*ast.Object
	violations  []StateViolation
	seen        map[token.Pos]bool
}

func newStateAnalyzer(positions *token.FileSet, name string, file *ast.File, schema stateSchema, domains []string) *stateAnalyzer {
	value := &stateAnalyzer{
		positions: positions, name: name, file: file, schema: schema,
		adopted: domainSet{}, aliases: contractImportAliases(file), seen: map[token.Pos]bool{},
	}
	for _, domain := range domains {
		value.adopted[domain] = true
	}
	return value
}

func contractImportAliases(file *ast.File) map[string]bool {
	aliases := map[string]bool{}
	for _, imported := range file.Imports {
		path, _ := strconv.Unquote(imported.Path.Value)
		if path != "github.com/Stephen-Sim/dant/core/internal/contracts" {
			continue
		}
		alias := "contracts"
		if imported.Name != nil {
			alias = imported.Name.Name
		}
		aliases[alias] = true
	}
	return aliases
}

func (value *stateAnalyzer) isContractAlias(name string, position token.Pos) bool {
	if aliases, ok := value.fileAliases[value.positions.PositionFor(position, false).Filename]; ok {
		return aliases[name]
	}
	return value.aliases[name]
}

func (value *stateAnalyzer) objects(name *ast.Ident) []*ast.Object {
	if name.Obj != nil {
		return []*ast.Object{name.Obj}
	}
	return value.symbols[name.Name]
}

func (value *stateAnalyzer) typeDomains(expression ast.Expr) domainSet {
	return value.typeDomainsAt(expression, 0)
}

func (value *stateAnalyzer) typeDomainsAt(expression ast.Expr, depth int) domainSet {
	if depth > 16 {
		return nil
	}
	switch node := expression.(type) {
	case *ast.ParenExpr:
		return value.typeDomainsAt(node.X, depth+1)
	case *ast.SelectorExpr:
		owner, ok := node.X.(*ast.Ident)
		if ok && value.isContractAlias(owner.Name, owner.Pos()) && len(value.schema.Domains[node.Sel.Name]) > 0 {
			return domainSet{node.Sel.Name: true}
		}
	case *ast.Ident:
		if value.isContractAlias(".", node.Pos()) && len(value.schema.Domains[node.Name]) > 0 {
			return domainSet{node.Name: true}
		}
		for _, object := range value.objects(node) {
			if declaration, ok := object.Decl.(*ast.TypeSpec); ok {
				return value.typeDomainsAt(declaration.Type, depth+1)
			}
		}
	}
	return nil
}

func (value *stateAnalyzer) nameDomains(name string) domainSet {
	lower := strings.ToLower(name)
	result := domainSet{}
	for domain := range value.adopted {
		match := false
		switch {
		case strings.HasSuffix(lower, "priority"):
			match = domain == "TaskPriority"
		case strings.HasSuffix(lower, "phase") || strings.HasSuffix(lower, "phases"):
			match = strings.HasSuffix(domain, "Phase")
		case strings.HasSuffix(lower, "status") || strings.HasSuffix(lower, "statuses"):
			match = strings.HasSuffix(domain, "Status")
		case strings.HasSuffix(lower, "stage"):
			match = domain == "TaskProgressStage"
		case strings.HasSuffix(lower, "provider"):
			match = domain == "VmProviderId"
		case strings.HasSuffix(lower, "mode"):
			match = domain == "BackupMode"
		case lower == "goos" || lower == "os":
			match = domain == "RuntimeOperatingSystem"
		case strings.HasSuffix(lower, "platform"):
			match = domain == "HostPlatformId"
		case strings.HasSuffix(lower, "submission"):
			match = domain == "SubmissionStatus"
		case strings.HasSuffix(lower, "state") || strings.HasSuffix(lower, "states"):
			match = strings.HasSuffix(domain, "Status") || domain == "VmPowerState"
		}
		if match {
			result[domain] = true
		}
	}
	return result
}

func (value *stateAnalyzer) expressionDomains(expression ast.Expr, depth int) domainSet {
	if expression == nil || depth > 16 {
		return nil
	}
	switch node := expression.(type) {
	case *ast.ParenExpr:
		return value.expressionDomains(node.X, depth+1)
	case *ast.SelectorExpr:
		if owner, ok := node.X.(*ast.Ident); ok && value.isContractAlias(owner.Name, owner.Pos()) {
			for domain := range value.adopted {
				if strings.HasPrefix(node.Sel.Name, domain) {
					return domainSet{domain: true}
				}
			}
		}
		if node.Sel.Name == "Value" {
			return value.expressionDomains(node.X, depth+1)
		}
		return value.nameDomains(node.Sel.Name)
	case *ast.IndexExpr:
		if name, ok := stringValue(node.Index); ok {
			return value.nameDomains(name)
		}
		return value.expressionDomains(node.X, depth+1)
	case *ast.CallExpr:
		if domains := value.typeDomains(node.Fun); len(domains) > 0 {
			return domains
		}
		if function, ok := node.Fun.(*ast.Ident); ok && function.Name == "string" && len(node.Args) == 1 {
			return value.expressionDomains(node.Args[0], depth+1)
		}
	case *ast.Ident:
		for _, object := range value.objects(node) {
			switch declaration := object.Decl.(type) {
			case *ast.Field:
				if domains := value.typeDomains(declaration.Type); len(domains) > 0 {
					return domains
				}
			case *ast.ValueSpec:
				if domains := value.typeDomains(declaration.Type); len(domains) > 0 {
					return domains
				}
				for index, name := range declaration.Names {
					if name.Obj == object && index < len(declaration.Values) {
						if domains := value.expressionDomains(declaration.Values[index], depth+1); len(domains) > 0 {
							return domains
						}
					}
				}
			case *ast.AssignStmt:
				for index, left := range declaration.Lhs {
					if name, ok := left.(*ast.Ident); ok && name.Obj == object && index < len(declaration.Rhs) {
						if domains := value.expressionDomains(declaration.Rhs[index], depth+1); len(domains) > 0 {
							return domains
						}
					}
				}
			}
		}
		return value.nameDomains(node.Name)
	}
	return nil
}

func stringValue(expression ast.Expr) (string, bool) {
	switch node := expression.(type) {
	case *ast.BasicLit:
		if node.Kind != token.STRING {
			return "", false
		}
		text, err := strconv.Unquote(node.Value)
		return text, err == nil
	case *ast.ParenExpr:
		return stringValue(node.X)
	case *ast.BinaryExpr:
		if node.Op == token.ADD {
			left, leftOK := stringValue(node.X)
			right, rightOK := stringValue(node.Y)
			return left + right, leftOK && rightOK
		}
	}
	return "", false
}

func (value *stateAnalyzer) record(expression ast.Expr, domains domainSet) bool {
	text, ok := stringValue(expression)
	if !ok {
		return false
	}
	for domain := range domains {
		for _, wire := range value.schema.Domains[domain] {
			if wire != text || value.seen[expression.Pos()] {
				continue
			}
			position := value.positions.PositionFor(expression.Pos(), false)
			value.violations = append(value.violations, StateViolation{File: position.Filename, Line: position.Line, Column: position.Column, Value: text})
			value.seen[expression.Pos()] = true
			return true
		}
	}
	return true
}

func (value *stateAnalyzer) inspectExpression(expression ast.Expr, domains domainSet, depth int) {
	if expression == nil || depth > 16 {
		return
	}
	if value.record(expression, domains) {
		return
	}
	switch node := expression.(type) {
	case *ast.ParenExpr:
		value.inspectExpression(node.X, domains, depth+1)
	case *ast.Ident:
		for _, object := range value.objects(node) {
			switch declaration := object.Decl.(type) {
			case *ast.ValueSpec:
				for index, name := range declaration.Names {
					if name.Obj == object && index < len(declaration.Values) {
						value.inspectExpression(declaration.Values[index], domains, depth+1)
					}
				}
			case *ast.AssignStmt:
				for index, expression := range declaration.Lhs {
					if name, ok := expression.(*ast.Ident); ok && name.Obj == object && index < len(declaration.Rhs) {
						value.inspectExpression(declaration.Rhs[index], domains, depth+1)
					}
				}
			}
		}
	case *ast.CompositeLit:
		var keyDomains, elementDomains domainSet
		switch kind := node.Type.(type) {
		case *ast.MapType:
			keyDomains, elementDomains = value.typeDomains(kind.Key), value.typeDomains(kind.Value)
			if name, ok := kind.Key.(*ast.Ident); ok && name.Name == "string" && len(keyDomains) == 0 {
				if element, ok := kind.Value.(*ast.Ident); ok && element.Name == "bool" {
					keyDomains = domains
				}
			}
			if name, ok := kind.Value.(*ast.Ident); ok && name.Name == "string" && len(elementDomains) == 0 {
				elementDomains = domains
			}
		case *ast.ArrayType:
			elementDomains = value.typeDomains(kind.Elt)
			if len(elementDomains) == 0 {
				elementDomains = domains
			}
		}
		for _, element := range node.Elts {
			if field, ok := element.(*ast.KeyValueExpr); ok {
				value.inspectExpression(field.Key, keyDomains, depth+1)
				context := elementDomains
				if name, ok := field.Key.(*ast.Ident); ok {
					context = value.nameDomains(name.Name)
				}
				if name, ok := stringValue(field.Key); ok && len(context) == 0 {
					context = value.nameDomains(name)
				}
				value.inspectExpression(field.Value, context, depth+1)
			} else {
				value.inspectExpression(element, elementDomains, depth+1)
			}
		}
	case *ast.CallExpr:
		context := value.typeDomains(node.Fun)
		if len(context) == 0 {
			switch function := node.Fun.(type) {
			case *ast.Ident:
				context = value.nameDomains(strings.TrimPrefix(function.Name, "set"))
			case *ast.SelectorExpr:
				context = value.nameDomains(strings.TrimPrefix(function.Sel.Name, "Set"))
			}
		}
		if len(context) == 0 {
			context = domains
		}
		var parameterDomains []domainSet
		if name, ok := node.Fun.(*ast.Ident); ok {
			for _, object := range value.objects(name) {
				if declaration, ok := object.Decl.(*ast.FuncDecl); ok && declaration.Type.Params != nil {
					for _, field := range declaration.Type.Params.List {
						for range max(1, len(field.Names)) {
							parameterDomains = append(parameterDomains, value.typeDomains(field.Type))
						}
					}
				}
			}
		}
		for index, argument := range node.Args {
			parameterContext := context
			if index < len(parameterDomains) && len(parameterDomains[index]) > 0 {
				parameterContext = parameterDomains[index]
			}
			value.inspectExpression(argument, parameterContext, depth+1)
		}
	}
}

func (value *stateAnalyzer) checkReturns(body *ast.BlockStmt, signature *ast.FuncType) {
	if body == nil || signature.Results == nil {
		return
	}
	var contexts []domainSet
	for _, field := range signature.Results.List {
		for range max(1, len(field.Names)) {
			contexts = append(contexts, value.typeDomains(field.Type))
		}
	}
	ast.Inspect(body, func(node ast.Node) bool {
		if _, nested := node.(*ast.FuncLit); nested {
			return false
		}
		if result, ok := node.(*ast.ReturnStmt); ok {
			for index, expression := range result.Results {
				if index < len(contexts) {
					value.inspectExpression(expression, contexts[index], 0)
				}
			}
		}
		return true
	})
}

func (value *stateAnalyzer) check() []StateViolation {
	ast.Inspect(value.file, func(node ast.Node) bool {
		switch current := node.(type) {
		case *ast.ValueSpec:
			for index, expression := range current.Values {
				context := value.typeDomains(current.Type)
				if len(context) == 0 && index < len(current.Names) {
					context = value.nameDomains(current.Names[index].Name)
				}
				value.inspectExpression(expression, context, 0)
			}
		case *ast.AssignStmt:
			for index, expression := range current.Rhs {
				if index < len(current.Lhs) {
					value.inspectExpression(expression, value.expressionDomains(current.Lhs[index], 0), 0)
				}
			}
		case *ast.BinaryExpr:
			if current.Op == token.EQL || current.Op == token.NEQ || current.Op == token.LSS || current.Op == token.LEQ || current.Op == token.GTR || current.Op == token.GEQ {
				value.inspectExpression(current.X, value.expressionDomains(current.Y, 0), 0)
				value.inspectExpression(current.Y, value.expressionDomains(current.X, 0), 0)
			}
		case *ast.SwitchStmt:
			context := value.expressionDomains(current.Tag, 0)
			for _, statement := range current.Body.List {
				if clause, ok := statement.(*ast.CaseClause); ok {
					for _, expression := range clause.List {
						value.inspectExpression(expression, context, 0)
					}
				}
			}
		case *ast.CompositeLit:
			value.inspectExpression(current, nil, 0)
		case *ast.CallExpr:
			value.inspectExpression(current, nil, 0)
			if function, ok := current.Fun.(*ast.SelectorExpr); ok && (function.Sel.Name == "Contains" || function.Sel.Name == "Index") && len(current.Args) == 2 {
				value.inspectExpression(current.Args[0], value.expressionDomains(current.Args[1], 0), 0)
			}
		case *ast.FuncDecl:
			value.checkReturns(current.Body, current.Type)
		case *ast.FuncLit:
			value.checkReturns(current.Body, current.Type)
		}
		return true
	})
	return value.violations
}
