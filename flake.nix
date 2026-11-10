{
  description = "Shiki SVG Exporter";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      forEachSystem = nixpkgs.lib.genAttrs [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      packages = forEachSystem (
        system:
        let
          pkgs = pkgsFor system;
          pnpm = pkgs.pnpm_10;
        in
        rec {
          shiki-svg-export = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
            pname = "shiki-svg-export";
            version = "0.1.0";
            src = self;

            nativeBuildInputs = [
              pkgs.nodejs
              pnpm
              pkgs.pnpmConfigHook
            ];

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit pnpm;
              fetcherVersion = 5;
              hash = "sha256-KbfTSJ/EwRjEdALsYPe2/D5SEgCNfhGdYAg5Qgc5dV8=";
            };

            buildPhase = ''
              runHook preBuild
              pnpm run build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall
              cp -r dist $out
              runHook postInstall
            '';
          });

          serve = pkgs.writeShellApplication {
            name = "shiki-svg-export";
            runtimeInputs = [ pkgs.python3 ];
            text = ''
              port="''${PORT:-8080}"
              echo "Serving on http://localhost:$port"
              exec python3 -m http.server "$port" --bind 127.0.0.1 --directory ${shiki-svg-export}
            '';
          };

          default = shiki-svg-export;
        }
      );

      apps = forEachSystem (system: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${system}.serve;
        };
      });

      devShells = forEachSystem (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs
              pkgs.pnpm_10
            ];
          };
        }
      );
    };
}
