import checkbox from "@inquirer/checkbox";
import { input, confirm } from "@inquirer/prompts";
import select from "@inquirer/select";
import fs from "fs";
import { promisify } from "util";
const exec = promisify(require("child_process").exec);

let root = "..";
const baseFolder = "kubernetes/apps";

const main = async () => {
  await preRunEnvCheck();

  const currentContext = await execute("kubectl config current-context");

  const dirents = fs.readdirSync(`${root}/${baseFolder}`, {
    withFileTypes: true,
  });
  const folderNames = dirents
    .filter((dirent) => !dirent.isFile())
    .map((dirent) => dirent.name);

  const environments = await checkbox({
    message: "Select one or more environments to create secrets for \n",
    choices: [{ name: "kcat (Kubeseal)", value: "cat" }],
  });
  const secretName = await input({
    message: "Enter your secret-name:  example-secret-format\n",
  });
  const secret = await input({ message: "Enter your secret value \n" });
  const output = await select({
    message: "Where do you want the output? \n",
    choices: [
      {
        name: "in the service/secret folders",
        value: "service",
        description: "You will be able to choose your service in the next step",
      },
      {
        name: "in local ./output folder",
        value: "output",
        description: "Good if you want to copy over your own files",
      },
    ],
  });

  let serviceName;
  if (output === "service") {
    const choices = folderNames.map((item) => ({ name: item, value: item }));
    serviceName = await select({
      message: "Select a service (based on /base)",
      choices: choices,
    });
  }

  let canWriteToK8sFolder;

  if (serviceName) {
    canWriteToK8sFolder = await canWriteToK8s({
      serviceName: serviceName,
      environments: environments,
      secretName: secretName,
    });
  }

  if (canWriteToK8sFolder) {
    for (const env of environments) {
      await createSecret({
        environment: env,
        secretName: secretName,
        secret: secret,
        filePath: `${root}/${env}/${serviceName}/secrets`,
      });
    }
  } else {
    for (const env of environments) {
      const outputFolder = `output/secrets/${env}`;
      if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true });
      }
      await createSecret({
        environment: env,
        secretName: secretName,
        secret: secret,
        filePath: outputFolder,
      });
    }
  }

  await execute(`kubectl config use ${currentContext}`);

  console.log(
    "Dont forget to include your local secrets in secret-generator.yaml and remote secrets in kustomization.yaml"
  );
};

const createSecret = async (dto: {
  filePath: string;
  secretName: string;
  secret: string;
  environment: string;
}) => {
  if (dto.environment === "local-dev") {
    const base64secret = Buffer.from(dto.secret).toString("base64");
    await execute(`kubectl config use rancher-desktop`);

    if (!fs.existsSync("tmp")) {
      fs.mkdirSync("tmp");
    }
    fs.writeFileSync(
      `tmp/tempsecret.yaml`,
      `
apiVersion: v1
kind: Secret
metadata:
  name: ${dto.secretName}
data:
  ${dto.secretName}: ${base64secret}`
    );
    await execute(
      `sops -e tmp/tempsecret.yaml > ${dto.filePath}/${dto.secretName}.enc.yaml`
    );
    console.log(`Created secret ${dto.filePath}/${dto.secretName}.enc.yaml`);
  } else {
    await execute(`kubectl config use ${dto.environment}`);
    await execute(
      `kubectl create secret generic ${dto.secretName} --from-literal=${dto.secretName}=${dto.secret} --dry-run=client -o yaml | kubeseal -o yaml > ${dto.filePath}/${dto.secretName}.sealed.yaml`
    );
    console.log(`Created secret ${dto.filePath}/${dto.secretName}.sealed.yaml`);
  }
};

const preRunEnvCheck = async () => {
  const currentPath = await execute("pwd");
  if (currentPath.includes("create-secret-node-project")) {
    root = "..";
  } else {
    root = "..";
  }

  const result = await execute(`which kubectl`);

  if (result.includes(".rd/bin")) {
    const preCheckAnswer = await confirm({
      message: `WARNING: ${result} kubectl found, stage/prod auth possibly broken and context switch will hang your computer. \n\nRun "mv ~/.rd/bin/kubectl ~/.rd/bin/kubectl_back" to fix? \n\n`,
    });

    if (preCheckAnswer) {
      execute("mv ~/.rd/bin/kubectl ~/.rd/bin/kubectl_back");
    }
  }
};

async function execute(command: string) {
  const output = await exec(command);
  return output.stdout.replace("\n", "");
}

const canWriteToK8s = async (dto: {
  serviceName: string;
  environments: string[];
  secretName: string;
}) => {
  let kubeFolderWriteChecks;

  if (dto.serviceName) {
    kubeFolderWriteChecks = [];
    for (const env of dto.environments) {
      const secretFolder = `${root}/${env}/${dto.serviceName}/secrets`;

      if (!fs.existsSync(secretFolder)) {
        const createSecretFolderAnswer = await confirm({
          message: `Folder ${secretFolder} missing, do you want it created?`,
        });
        kubeFolderWriteChecks.push(createSecretFolderAnswer);
      }

      let secretFilePath;

      if (env === "local-dev") {
        secretFilePath = `${secretFolder}/${dto.secretName}.enc.yaml`;
      } else {
        secretFilePath = `${secretFolder}/${dto.secretName}.sealed.yaml`;
      }

      if (fs.existsSync(secretFilePath)) {
        const overwriteSecretAnswer = await confirm({
          message: `Secret ${secretFilePath} already exists, do you want to overwrite it?`,
        });

        kubeFolderWriteChecks.push(overwriteSecretAnswer);
      }
    }
  }

  const canWrite =
    dto.serviceName &&
    kubeFolderWriteChecks.every((check: boolean) => check === true);

  return canWrite;
};

main();
