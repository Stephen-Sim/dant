"""Pure task-plan schema parity; no desktop, VM, network or model execution."""
import ast
import json
import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


class TaskPlanContractTests(unittest.TestCase):
    def test_mcp_advertises_the_same_optional_status_and_step_contract_as_the_shared_parser(self):
        tree = ast.parse((ROOT / 'vm/desktop_mcp.py').read_text(encoding='utf-8'))
        tools = next(node.value for node in tree.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'TOOLS' for target in node.targets))
        task = next(node for node in tools.elts if isinstance(node, ast.Call) and ast.literal_eval(node.args[0]) == 'task_plan')
        actual = {'type': 'object', 'properties': ast.literal_eval(task.args[2]), 'required': ast.literal_eval(task.args[3]), 'additionalProperties': False}
        result = subprocess.run(['node', '--input-type=module', '-e', "import {TASK_PLAN_SCHEMA} from './src/work/task-progress.mts'; process.stdout.write(JSON.stringify({type:'object',properties:TASK_PLAN_SCHEMA,required:['title','steps'],additionalProperties:false}));"], cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertEqual(actual, json.loads(result.stdout))
        self.assertNotIn('status', actual['required'])
        self.assertNotIn('default', actual['properties']['status'])


if __name__ == '__main__':
    unittest.main()
