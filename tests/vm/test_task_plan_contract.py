"""Pure task-plan schema contract; no desktop, VM, network or model execution."""
import ast
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class TaskPlanContractTests(unittest.TestCase):
    def test_mcp_advertises_the_same_optional_status_and_step_contract_as_go_worker(self):
        tree = ast.parse((ROOT / 'vm/desktop_mcp.py').read_text(encoding='utf-8'))
        tools = next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'TOOLS' for target in node.targets))
        task = next(node for node in tools.elts if isinstance(node, ast.Call) and ast.literal_eval(node.args[0]) == 'task_plan')
        actual = {'type': 'object', 'properties': ast.literal_eval(task.args[2]), 'required': ast.literal_eval(task.args[3]), 'additionalProperties': False}
        tools = json.loads((ROOT / 'core/internal/work/assets/dynamic-tools.json').read_text(encoding='utf-8'))
        task = next(tool for tool in tools if tool['name'] == 'task_plan')
        self.assertEqual(actual, task['inputSchema'])
        self.assertNotIn('status', actual['required'])
        self.assertNotIn('default', actual['properties']['status'])


if __name__ == '__main__':
    unittest.main()
