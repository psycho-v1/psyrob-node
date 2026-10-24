// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Development team allocation: 12 % = 120,000,000 PSY, immutable (DAG_SPEC.md sections 7.1 and 8.6).
/// Nothing vests in the first 12 months; then it vests linearly until month 48. There is no owner, no admin, no
/// revocation and no way to change the beneficiary. The team has no governance power through this contract.
contract DevVesting {
    address public immutable beneficiary;
    uint256 public immutable start;
    uint256 public immutable cliff;
    uint256 public immutable end;
    uint256 public immutable allocation;
    uint256 public released;

    error NothingVested();
    error TransferFailed();
    error ZeroBeneficiary();

    event Released(uint256 amount);

    constructor(address beneficiary_, uint256 start_, uint256 allocation_) payable {
        if (beneficiary_ == address(0)) revert ZeroBeneficiary();
        beneficiary = beneficiary_;
        start = start_;
        cliff = start_ + 365 days;
        end = start_ + 4 * 365 days;
        allocation = allocation_;
    }

    function vested(uint256 t) public view returns (uint256) {
        if (t < cliff) return 0;
        if (t >= end) return allocation;
        return allocation * (t - start) / (end - start);
    }

    function releasable() public view returns (uint256) {
        return vested(block.timestamp) - released;
    }

    /// Anyone may trigger the release; the PSY always goes to the fixed beneficiary.
    function release() external {
        uint256 a = releasable();
        if (a == 0) revert NothingVested();
        released += a;
        emit Released(a);
        (bool ok,) = payable(beneficiary).call{value: a}("");
        if (!ok) revert TransferFailed();
    }
}
