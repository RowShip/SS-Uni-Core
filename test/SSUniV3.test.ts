import { assert, expect } from "chai";
import { BigNumber } from "bignumber.js";
import { ethers, network } from "hardhat";
import {
  IERC20,
  IUniswapV3Factory,
  IUniswapV3Pool,
  SwapTest,
  SSUniVault,
  SSUniFactory,
  EIP173Proxy,
} from "../typechain";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { BigNumberish } from "ethers";


describe("SSUniVault", () => {
  // eslint-disable-next-line
  BigNumber.config({ EXPONENTIAL_AT: 999999, DECIMAL_PLACES: 40 });

  // returns the sqrt price as a 64x96
  function encodePriceSqrt(reserve1: string, reserve0: string) {
    return new BigNumber(reserve1)
      .div(reserve0)
      .sqrt()
      .multipliedBy(new BigNumber(2).pow(96))
      .integerValue(3)
      .toString();
  }

  function position(address: string, lowerTick: number, upperTick: number) {
    return ethers.utils.solidityKeccak256(
      ["address", "int24", "int24"],
      [address, lowerTick, upperTick]
    );
  }
  async function mint(
    vault: SSUniVault,
    amount0: BigNumberish,
    amount1: BigNumberish,
    receiver: string
  ) {
    const result = await vault.callStatic.getMintAmounts(amount0, amount1);
    await vault.mint(result.mintAmount, receiver);
  }

  let uniswapFactory: IUniswapV3Factory;
  let uniswapPool: IUniswapV3Pool;

  let token0: IERC20;
  let token1: IERC20;
  let user0: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let swapTest: SwapTest;
  let sSUniVault: SSUniVault;
  let sSUniFactory: SSUniFactory;
  let gelato: SignerWithAddress;
  let SSTreasury: SignerWithAddress;
  let uniswapPoolAddress: string;
  let implementationAddress: string;

  before(async function () {
    [user0, user1, user2, gelato, SSTreasury] = await ethers.getSigners();

    const swapTestFactory = await ethers.getContractFactory("SwapTest");
    swapTest = (await swapTestFactory.deploy()) as SwapTest;
  });

  beforeEach(async function () {
    const uniswapV3Factory = await ethers.getContractFactory(
      "UniswapV3Factory"
    );
    const uniswapDeploy = await uniswapV3Factory.deploy();
    uniswapFactory = (await ethers.getContractAt(
      "IUniswapV3Factory",
      uniswapDeploy.address
    )) as IUniswapV3Factory;

    const mockERC20Factory = await ethers.getContractFactory("MockERC20");
    token0 = (await mockERC20Factory.deploy({ gasLimit: 30000000 })) as IERC20;
    token1 = (await mockERC20Factory.deploy({ gasLimit: 30000000 })) as IERC20;

    await token0.approve(
      swapTest.address,
      ethers.utils.parseEther("10000000000000")
    );
    await token1.approve(
      swapTest.address,
      ethers.utils.parseEther("10000000000000")
    );

    // Sort token0 & token1 so it follows the same order as Uniswap & the sSUniVaultFactory
    if (
      ethers.BigNumber.from(token0.address).gt(
        ethers.BigNumber.from(token1.address)
      )
    ) {
      const tmp = token0;
      token0 = token1;
      token1 = tmp;
    }

    await uniswapFactory.createPool(token0.address, token1.address, "3000");
    uniswapPoolAddress = await uniswapFactory.getPool(
      token0.address,
      token1.address,
      "3000"
    );
    uniswapPool = (await ethers.getContractAt(
      "IUniswapV3Pool",
      uniswapPoolAddress
    )) as IUniswapV3Pool;
    await uniswapPool.initialize(encodePriceSqrt("1", "1"));

    await uniswapPool.increaseObservationCardinalityNext("15");

    const sSUniVaultFactory = await ethers.getContractFactory("SSUniVault");
    const sSUniImplementation = await sSUniVaultFactory.deploy(
      await gelato.getAddress(),
      await SSTreasury.getAddress()
    );

    implementationAddress = sSUniImplementation.address;

    const sSUniFactoryFactory = await ethers.getContractFactory("SSUniFactory");

    const volatilityOracle = await (await ethers.getContractFactory("VolatilityOracle")).deploy();

    sSUniFactory = (await sSUniFactoryFactory.deploy(
      uniswapFactory.address,
      volatilityOracle.address
    )) as SSUniFactory;

    await sSUniFactory.initialize(
      implementationAddress,
      await user0.getAddress()
    );

    await sSUniFactory.deployVault(
      token0.address,
      token1.address,
      3000,
      await user0.getAddress(),
      0,
      -887220,
      887220
    );

    const deployers = await sSUniFactory.getDeployers();
    const deployer = deployers[0];
    const pools = await sSUniFactory.getPools(deployer);

    sSUniVault = (await ethers.getContractAt("SSUniVault", pools[0])) as SSUniVault;
  });
  describe("Before liquidity deposited", function () {
    beforeEach(async function () {
      await token0.approve(
        sSUniVault.address,
        ethers.utils.parseEther("1000000")
      );
      await token1.approve(
        sSUniVault.address,
        ethers.utils.parseEther("1000000")
      );
    });
    describe("deposit", function () {
      it("should deposit funds into SSUniVault", async function () {
        await mint(sSUniVault, ethers.utils.parseEther("1"), ethers.utils.parseEther("1"), await user0.getAddress());
        expect(await token0.balanceOf(uniswapPool.address)).to.be.gt(0);
        expect(await token1.balanceOf(uniswapPool.address)).to.be.gt(0);
        const [liquidity] = await uniswapPool.positions(
          position(sSUniVault.address, -887220, 887220)
        );
        expect(liquidity).to.be.gt(0);
        const supply = await sSUniVault.totalSupply();
        expect(supply).to.be.gt(0);

        await mint(sSUniVault, ethers.utils.parseEther("0.5"), ethers.utils.parseEther("1"), await user0.getAddress());
        const [liquidity2] = await uniswapPool.positions(
          position(sSUniVault.address, -887220, 887220)
        );
        assert(liquidity2.gt(liquidity));

        await sSUniVault.transfer(
          await user1.getAddress(),
          ethers.utils.parseEther("1")
        );
        await sSUniVault
          .connect(user1)
          .approve(await user0.getAddress(), ethers.utils.parseEther("1"));
        await sSUniVault
          .connect(user0)
          .transferFrom(
            await user1.getAddress(),
            await user0.getAddress(),
            ethers.utils.parseEther("1")
          );

        const decimals = await sSUniVault.decimals();
        const symbol = await sSUniVault.symbol();
        const name = await sSUniVault.name();
        expect(symbol).to.equal("SS-UNI 1");
        expect(decimals).to.equal(18);
        expect(name).to.equal("SwapSweep Vault V1 TOKEN/TOKEN");
      });
    });
    describe("onlyGelato", function () {
      let errorMessage: string;
      it("should fail if not called by gelato", async function () {
        errorMessage = "Gelatofied: Only gelato"
        // TODO: include test case for recenter function as well once thats coded out
        await expect(
          sSUniVault
            .connect(user1)
            .reinvest(
              encodePriceSqrt("10", "1"),
              1000,
              true,
              10,
              token0.address
            )
        ).to.be.revertedWith(errorMessage);
        await expect(
          sSUniVault
            .connect(user1)
            .recenter()
        ).to.be.revertedWith(errorMessage);
      });
      it("reinvest should fail if no fees earned", async function () {
        errorMessage = "high fee"
        await mint(sSUniVault, ethers.utils.parseEther("1"), ethers.utils.parseEther("1"), await user0.getAddress());
        
        // Update oracle params to ensure checkSlippage computes without error.
        const rebalanceBPS = 999;
        const tx = await sSUniVault.updateManagerParams(
          -1,
          ethers.constants.AddressZero,
          rebalanceBPS,
          -1,
          -1
        );
        if (network.provider && user0.provider && tx.blockHash) {
          const block = await user0.provider.getBlock(tx.blockHash);
          const executionTime = block.timestamp + 300;
          await network.provider.send("evm_mine", [executionTime]);
        }
        // get left over token 0 in contract
        const leftover0 = await token0.balanceOf(sSUniVault.address);
        // Set fee amount equal to the leftover token 0 times 1 basis point more than rebalanceBPS proportion
        // to ensure that the feeAmount is just barely too high to be reinvested. 
        let feeAmount = leftover0.mul(rebalanceBPS + 1).div(10000);
        await expect(
          sSUniVault
            .connect(gelato)
            .reinvest(
              encodePriceSqrt("10", "1"),
              1000,
              true,
              feeAmount,
              token0.address
            )
        ).to.be.revertedWith(errorMessage);

        feeAmount = leftover0.mul(rebalanceBPS + 1).div(10000);
        
         await sSUniVault
            .connect(gelato)
            .reinvest(
              encodePriceSqrt("10", "1"),
              1000,
              true,
              feeAmount,
              token0.address
            )
        await expect(
          sSUniVault.connect(gelato).withdrawManagerBalance()
        ).to.be.revertedWith(errorMessage);
      });
      it("should fail to recenter before deposits", async function () {
        errorMessage = "Denom != 0"
        await expect(
          sSUniVault.connect(gelato).recenter()
        ).to.be.revertedWith(errorMessage);
      });
    });
    describe("onlyManager", function () {
      it("should fail if not called by manager", async function () {
        const errorMessage = "Ownable: caller is not the manager"
        await expect(
          sSUniVault
            .connect(gelato)
            .updateManagerParams(
              -1,
              ethers.constants.AddressZero,
              300,
              5000,
              5000
            )
        ).to.be.revertedWith(errorMessage);

        await expect(
          sSUniVault.connect(gelato).transferOwnership(await user1.getAddress())
        ).to.be.revertedWith(errorMessage);
        await expect(sSUniVault.connect(gelato).renounceOwnership()).to.be
          .revertedWith(errorMessage);
      });
    });
    describe("after liquidity deposited", function () {
      beforeEach(async function () {
        await mint(sSUniVault, ethers.utils.parseEther("1"), ethers.utils.parseEther("1"), await user0.getAddress());
      });
      describe("withdrawal", function () {
        it("should burn vault tokens and withdraw funds", async function () {
          await sSUniVault.burn(
            (await sSUniVault.totalSupply()).div("2"),
            await user0.getAddress()
          );
          const [liquidity2] = await uniswapPool.positions(
            position(sSUniVault.address, -887220, 887220)
          );
          expect(liquidity2).to.be.gt(0);
          expect(await sSUniVault.totalSupply()).to.be.gt(0);
          expect(await sSUniVault.balanceOf(await user0.getAddress())).to.equal(
            ethers.utils.parseEther("0.5")
          );
        });
      });

      describe("after fees earned on trades", function () {
        beforeEach(async function () {
          await swapTest.washTrade(
            uniswapPool.address,
            "50000000000000",
            100,
            2
          );
          await swapTest.washTrade(
            uniswapPool.address,
            "50000000000000",
            100,
            3
          );
          await swapTest.washTrade(
            uniswapPool.address,
            "50000000000000",
            100,
            3
          );
          await swapTest.washTrade(
            uniswapPool.address,
            "50000000000000",
            100,
            3
          );
        });

        describe("reinvest fees", function () {
          it("should redeposit fees with a reinvest", async function () {
            const [liquidityOld] = await uniswapPool.positions(
              position(sSUniVault.address, -887220, 887220)
            );
            const gelatoBalanceBefore = await token1.balanceOf(
              await gelato.getAddress()
            );

            await expect(
              sSUniVault
                .connect(gelato)
                .reinvest(
                  encodePriceSqrt("1", "1"),
                  5000,
                  true,
                  10,
                  token0.address
                )
            ).to.be.revertedWith("OLD");

            const tx = await sSUniVault.updateManagerParams(
              "1000",
              "100",
              "500",
              "300",
              await user0.getAddress()
            );
            if (network.provider && user0.provider && tx.blockHash) {
              const block = await user0.provider.getBlock(tx.blockHash);
              const executionTime = block.timestamp + 300;
              await network.provider.send("evm_mine", [executionTime]);
            }

            const { sqrtPriceX96 } = await uniswapPool.slot0();
            // TODO: Write a resolver function that automatically generates slippagePrice from oracle readings.
            const slippagePrice = sqrtPriceX96.sub(
              sqrtPriceX96.div(ethers.BigNumber.from("25"))
            );

            await sSUniVault
              .connect(gelato)
              .reinvest(slippagePrice, 5000, true, 5, token1.address);
            // TODO: Write a resolver function with a gas limit to control.
            const gelatoBalanceAfter = await token1.balanceOf(
              await gelato.getAddress()
            );
            expect(gelatoBalanceAfter).to.be.gt(gelatoBalanceBefore);
            expect(
              Number(gelatoBalanceAfter.sub(gelatoBalanceBefore))
            ).to.be.equal(5);

            const [liquidityNew] = await uniswapPool.positions(
              position(sSUniVault.address, -887220, 887220)
            );
            expect(liquidityNew).to.be.gt(liquidityOld);
          });
        });
      })
    })
  });
});