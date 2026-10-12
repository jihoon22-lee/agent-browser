"""Small regressions for the existing WSL packager; standard library only."""
import importlib.util
import pathlib
import unittest
import sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location("package_release", pathlib.Path(__file__).resolve().parents[2]/"scripts/package-release.py")
package=importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)
class ExtensionManifestTests(unittest.TestCase):
    def test_version_mismatch_is_rejected(self):
        with self.assertRaises(ValueError):
            package.validate_extension({"manifest_version":3,"key":"fixture","version":"0.1.4"},"0.1.5")
    def test_matching_version_is_accepted(self):
        package.validate_extension({"manifest_version":3,"key":"fixture","version":"0.1.5"},"0.1.5")
    def test_keyed_mv3_remains_required(self):
        for manifest in [{"manifest_version":2,"key":"fixture","version":"0.1.5"},{"manifest_version":3,"version":"0.1.5"}]:
            with self.assertRaises(ValueError):
                package.validate_extension(manifest,"0.1.5")
if __name__=="__main__": unittest.main()
